import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ClerkProvider,
  SignIn,
  SignUp,
  Show,
  useClerk,
  useUser,
  SignOutButton,
} from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import {
  Switch,
  Route,
  useLocation,
  Router as WouterRouter,
  Redirect,
  Link,
  useParams,
} from "wouter";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
  useMutation,
} from "@tanstack/react-query";
import { CoachVideoManager } from "./components/coach-video-manager";
import { AdminPillarData } from "./components/admin-pillar-data";
import { KnowledgeWorkspace } from "./components/knowledge-workspace";
import { STUDY_DESIGNS, studyDesignLabel } from "@workspace/db/study-design";
import {
  RELIABILITY_AXES,
  RELIABILITY_ANSWERS,
  reliabilityBand,
  reliabilityBandLabel,
  scoreAxis,
  emptyRubric,
  normalizeRubric,
  type ReliabilityRubric,
  type ReliabilityAnswer,
  type ReliabilityAxisKey,
  type AxisScore,
} from "@workspace/db/source-rigor";

const queryClient = new QueryClient();

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const FACULTY_LOGO_SRC = `${basePath}/asklifestylemedicine-logo.png`;

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

// Warm onboarding illustrations live in faculty `public/illustrations/`.
// Served under the artifact base path; transparent PNGs so they blend on
// any cream/white card. Shared across every steward (no per-pillar variation).
const illu = (name: string): string => `${basePath}/illustrations/${name}.png`;
// Large photographic hero images ship as JPG (much smaller than PNG at size).
const illuJpg = (name: string): string =>
  `${basePath}/illustrations/${name}.jpg`;

// Per-pillar hand-drawn illustrations (same warm line-art style as `illu`).
// Canonical Stanford LM pillars get their own art; any other slug (custom
// pillars, retired non-LM ones) falls back to a neutral classical column.
const PILLAR_ILLU: Record<string, string> = {
  movement: "pillar-movement",
  nutrition: "pillar-nutrition",
  sleep: "pillar-sleep",
  "stress-management": "pillar-stress",
  "social-connection": "pillar-social",
  "cognitive-enhancement": "pillar-cognition",
  "gratitude-purpose": "pillar-gratitude",
};
const pillarIllu = (slug: string): string =>
  illu(PILLAR_ILLU[slug] ?? "pillar-default");

// Warm, hand-drawn Stanford-campus + topic illustrations used as the header
// band of the faculty-portal "Your pillars" cards (distinct from the small
// line-art icons above). Any slug without its own art falls back to a neutral
// campus scene.
const PILLAR_CARD_ART: Record<string, string> = {
  movement: "card-movement",
  nutrition: "card-nutrition",
  sleep: "card-sleep",
  "stress-management": "card-stress",
  "social-connection": "card-social",
  "cognitive-enhancement": "card-cognition",
  "gratitude-purpose": "card-gratitude",
};
const pillarCardArt = (slug: string): string =>
  illu(PILLAR_CARD_ART[slug] ?? "card-default");

// Curated pillar set shown on the signed-out landing page. This is a deliberate,
// fixed editorial set, driven here in the frontend (NOT by whatever the DB
// returns) so the page always presents the partnership story. Stewards who have
// committed to a pillar are named here as editorial content; the anonymous
// public pillars endpoint still never serializes steward identity. A pillar with
// no `steward` named yet simply hasn't rolled out publicly here.
type LandingPillar = {
  slug: string;
  name: string;
  institution: string;
  art: string;
  steward?: string;
  /** Whether the pillar has formally rolled out (shows the "Active" badge). A
   * pillar can have a named steward without being live yet (still "Soon"). */
  live?: boolean;
};
const LANDING_PILLARS: LandingPillar[] = [
  {
    slug: "sleep",
    name: "Sleep",
    institution: "Stanford Lifestyle Medicine",
    art: illu("card-sleep"),
    steward: "Prof. Jamie Zeitzer",
    live: true,
  },
  {
    slug: "slm-ai-lab",
    name: "AI Lab for Education and Leadership",
    institution: "Stanford Lifestyle Medicine",
    art: illu("card-default"),
    steward: "Karan Dehghani",
    live: true,
  },
  {
    slug: "reputation-management",
    name: "Reputation Management & Communication",
    institution: "Stanford",
    art: illu("card-default"),
    steward: "Allison Kluger",
    live: true,
  },
  {
    slug: "movement",
    name: "Movement",
    institution: "Stanford Lifestyle Medicine",
    art: illu("card-movement"),
    steward: "Anne Friedlander",
    live: true,
  },
  {
    slug: "nutrition",
    name: "Nutrition",
    institution: "Stanford Lifestyle Medicine",
    art: illu("card-nutrition"),
    steward: "Marily Oppezzo",
    live: true,
  },
  {
    slug: "stress-management",
    name: "Stress Management",
    institution: "Stanford Lifestyle Medicine",
    art: illu("card-stress"),
    steward: "Sarah Meyer Tapia",
    live: true,
  },
  {
    slug: "social-connection",
    name: "Social Engagement",
    institution: "Stanford Lifestyle Medicine",
    art: illu("card-social"),
    steward: "Steven Crane",
    live: true,
  },
  {
    slug: "cognitive-enhancement",
    name: "Cognitive Enhancement",
    institution: "Stanford Lifestyle Medicine",
    art: illu("card-cognition"),
    steward: "Shaliza Shorey",
    live: true,
  },
  {
    slug: "gratitude-purpose",
    name: "Gratitude & Purpose",
    institution: "Stanford Lifestyle Medicine",
    art: illu("card-gratitude"),
    steward: "Bruce Feldstein & Barbara Waxman",
    live: true,
  },
  {
    slug: "autism",
    name: "Autism",
    institution: "Stanford Lifestyle Medicine",
    art: illu("card-default"),
    steward: "Dr. Karen Parker",
    live: true,
  },
];

// Object-storage headshots are saved as "/objects/..." paths; the API serves
// them at /api/storage<path>. Returns null when no photo is set.
const headshotSrc = (photoUrl: string | null | undefined): string | null =>
  photoUrl ? `/api/storage${photoUrl}` : null;

// Up to two initials from a name, for the placeholder avatar when no headshot
// has been uploaded yet.
const initialsOf = (name: string | null | undefined): string => {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
};

/**
 * A steward's circular headshot, falling back to a tidy initials avatar when no
 * photo has been uploaded (or the image fails to load) — never a broken image.
 */
export function StewardAvatar({
  name,
  photoUrl,
  size = 40,
  className = "",
}: {
  name: string | null;
  photoUrl: string | null;
  size?: number;
  className?: string;
}) {
  const src = headshotSrc(photoUrl);
  const [errored, setErrored] = useState(false);
  const ring = "border-2 border-white shadow-sm";
  if (src && !errored) {
    return (
      <img
        src={src}
        alt={name ?? "Steward"}
        onError={() => setErrored(true)}
        className={`rounded-full object-cover bg-white ${ring} ${className}`}
        style={{ width: size, height: size }}
        data-testid="img-steward-avatar"
      />
    );
  }
  return (
    <span
      aria-label={name ?? undefined}
      className={`rounded-full bg-[#8C1515]/10 text-[#8C1515] font-medium inline-flex items-center justify-center select-none ${ring} ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      data-testid="avatar-steward-initials"
    >
      {initialsOf(name)}
    </span>
  );
}

/**
 * Uploads an image to object storage via the shared presigned-URL flow and
 * returns the saved "/objects/..." path. Used for steward headshots.
 */
async function uploadHeadshotFile(file: File): Promise<string> {
  const meta = await fetch("/api/storage/uploads/request-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      contentType: file.type,
    }),
  }).then((r) => r.json());
  if (!meta.uploadURL) throw new Error("Could not get an upload URL");
  const putRes = await fetch(meta.uploadURL, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!putRes.ok) throw new Error("Upload failed");
  return meta.objectPath as string;
}

/**
 * Headshot picker + preview. Uploads the chosen file to object storage, then
 * hands the resulting path (or null on remove) to `onChange` so the parent can
 * persist it. Validates type + size and shows a graceful placeholder.
 */
function HeadshotField({
  name,
  photoUrl,
  onChange,
  disabled,
  saving,
}: {
  name: string | null;
  photoUrl: string | null;
  onChange: (objectPath: string | null) => void;
  disabled?: boolean;
  saving?: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function pick(file: File | undefined): Promise<void> {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setErr("Please choose an image file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setErr("Image must be under 5 MB.");
      return;
    }
    setErr(null);
    setUploading(true);
    try {
      const objectPath = await uploadHeadshotFile(file);
      onChange(objectPath);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const busy = !!disabled || uploading || !!saving;
  return (
    <div className="flex items-center gap-4">
      <StewardAvatar name={name} photoUrl={photoUrl} size={64} />
      <div className="min-w-0">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => pick(e.target.files?.[0])}
          data-testid="input-headshot"
        />
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="bg-[#8C1515] text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition disabled:opacity-40"
            data-testid="button-upload-headshot"
          >
            {uploading
              ? "Uploading…"
              : saving
                ? "Saving…"
                : photoUrl
                  ? "Change photo"
                  : "Upload photo"}
          </button>
          {photoUrl && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onChange(null)}
              className="text-sm text-[#8C1515] underline hover:no-underline disabled:opacity-40"
              data-testid="button-remove-headshot"
            >
              Remove
            </button>
          )}
        </div>
        <p className="text-xs text-[#8a6a5a] mt-1">
          A square headshot works best. JPG or PNG, under 5&nbsp;MB.
        </p>
        {err && (
          <p
            className="text-xs text-[#E8352A] mt-1"
            data-testid="text-headshot-error"
          >
            {err}
          </p>
        )}
      </div>
    </div>
  );
}

// Per-pillar brand logo shown in a steward's dashboard greeting area. The seven
// canonical Stanford Lifestyle Medicine pillars share the Stanford | Lifestyle
// Medicine wordmark (which already carries the Stanford name); Matt Abrahams'
// `communication` pillar carries his "Think Faster, Talk Smarter" book-cover. Any other slug
// (custom or retired non-LM pillar) returns null so the dashboard stays unbranded.
const SLM_PILLAR_SLUGS = new Set<string>([
  "movement",
  "nutrition",
  "sleep",
  "stress-management",
  "social-connection",
  "cognitive-enhancement",
  "gratitude-purpose",
]);
type PillarLogo = { src: string; alt: string; kind: "book" | "slm" };
const pillarLogo = (slug: string): PillarLogo | null => {
  if (slug === "communication")
    return {
      src: `${basePath}/think-faster-talk-smarter-logo.png`,
      alt: "Think Faster, Talk Smarter — Matt Abrahams",
      kind: "book",
    };
  if (SLM_PILLAR_SLUGS.has(slug))
    return {
      src: FACULTY_LOGO_SRC,
      alt: "Stanford Lifestyle Medicine",
      kind: "slm",
    };
  return null;
};

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");
}

const clerkAppearance = {
  variables: {
    colorPrimary: "#8C1515",
    colorBackground: "#FFFFFF",
    colorForeground: "#2E2D29",
    colorMutedForeground: "#5F574F",
    colorInput: "#FFFFFF",
    colorInputForeground: "#2E2D29",
    colorNeutral: "#D5D0C8",
    colorDanger: "#E8352A",
    fontFamily:
      "'Source Sans 3', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    borderRadius: "8px",
  },
  elements: {
    // Hide the "Didn't receive a code? Resend (NN)" countdown — the
    // ticking number is anxiety-inducing during sign-in. Users can
    // refresh the page to request a new code.
    formResendCodeLink: { display: "none" },
    socialButtonsBlockButton: { display: "none" },
    dividerRow: { display: "none" },
    dividerLine: { display: "none" },
    dividerText: { display: "none" },
  },
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${FACULTY_LOGO_SRC}`,
  },
};

const aslmClerkAppearance = {
  ...clerkAppearance,
  options: {
    ...clerkAppearance.options,
    logoImageUrl: `${window.location.origin}${FACULTY_LOGO_SRC}`,
  },
  variables: {
    ...clerkAppearance.variables,
    colorBackground: "#FFFFFF",
    colorForeground: "#2E2D29",
    colorMutedForeground: "#5F574F",
    colorInput: "#FFFFFF",
    colorInputForeground: "#2E2D29",
    colorNeutral: "#D5D0C8",
    borderRadius: "0px",
  },
  elements: {
    ...clerkAppearance.elements,
    rootBox: {
      width: "100%",
      display: "flex",
      justifyContent: "center",
    },
    cardBox: {
      width: "440px",
      maxWidth: "100%",
      background: "#FFFFFF",
      border: "1px solid #D5D0C8",
      borderRadius: "0",
      boxShadow: "0 16px 42px rgba(46,45,41,0.10)",
      overflow: "hidden",
    },
    card: {
      background: "transparent",
      border: "0",
      borderRadius: "0",
      boxShadow: "none",
    },
    footer: {
      background: "transparent",
      border: "0",
      borderRadius: "0",
      boxShadow: "none",
    },
    headerTitle: {
      color: "#2E2D29",
      fontFamily: "'Source Sans 3', sans-serif",
      fontWeight: "600",
    },
    headerSubtitle: {
      color: "#5F574F",
      fontFamily: "'Source Sans 3', sans-serif",
    },
    formFieldLabel: {
      color: "#2E2D29",
      fontFamily: "'Source Sans 3', sans-serif",
      fontSize: "15px",
    },
    formFieldInput: {
      minHeight: "48px",
      borderColor: "#8C8780",
      borderRadius: "0",
      fontFamily: "'Source Sans 3', sans-serif",
      fontSize: "16px",
    },
    formButtonPrimary: {
      minHeight: "48px",
      borderRadius: "0",
      backgroundColor: "#8C1515",
      fontFamily: "'Source Sans 3', sans-serif",
      fontSize: "16px",
      fontWeight: "600",
      boxShadow: "none",
    },
    footerActionLink: {
      color: "#8C1515",
      fontWeight: "600",
    },
  },
};

// Friendlier copy for Clerk's brute-force protection errors on the sign-in
// card. Clerk locks an account after too many failed password attempts and
// rate-limits rapid retries; by default the card shows a terse "too many
// requests" style error. These overrides replace that with a human
// explanation (including the remaining wait when Clerk provides one) and a
// way out — ask an admin to unlock. The `unstable__errors` keys are keyed by
// Clerk API error code, so only these two errors are affected; everything
// else keeps Clerk's default copy. Cast: the installed localization type
// doesn't declare every error-code key, but clerk-js resolves them by code
// at runtime.
const clerkLocalization = {
  unstable__errors: {
    user_locked:
      "Your account is temporarily locked after too many sign-in attempts. You can try again in {{duration}} — or ask a Stanford admin to unlock you right away.",
    too_many_requests:
      "Too many sign-in attempts in a short time. Please wait a few minutes and try again — or ask a Stanford admin to unlock your account.",
  },
} as Record<string, unknown>;

// ---------- API helpers ----------

// ---------- Admin "view as" preview store ----------
// A platform admin can preview any member's portal exactly as they see it.
// The store is module-level so the plain `fetchJson` helper can read it
// without prop-drilling; `useViewAs` lets components react to changes.
type ViewAsTarget = { id: number; name: string };
let _viewAs: ViewAsTarget | null = null;
const viewAsListeners = new Set<() => void>();
function getViewAs(): ViewAsTarget | null {
  return _viewAs;
}
export function setViewAs(t: ViewAsTarget | null): void {
  _viewAs = t;
  viewAsListeners.forEach((l) => l());
}
function subscribeViewAs(listener: () => void): () => void {
  viewAsListeners.add(listener);
  return () => {
    viewAsListeners.delete(listener);
  };
}
function useViewAs(): ViewAsTarget | null {
  return useSyncExternalStore(subscribeViewAs, getViewAs, getViewAs);
}

export async function fetchJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const viewAs = _viewAs;
  // Preview is strictly read-only: block any mutation while previewing so
  // an admin can never accidentally write as themselves into a member's view.
  if (viewAs && method !== "GET") {
    throw new Error(
      "Read-only preview — exit preview to make changes as yourself.",
    );
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (viewAs) headers["x-faculty-view-as"] = String(viewAs.id);
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

interface PillarSteward {
  name: string | null;
  photoUrl: string | null;
}

interface Me {
  user: {
    id: number;
    email: string;
    fullName: string | null;
    institution: string | null;
    photoUrl: string | null;
    achievements: string[];
    isPlatformAdmin: boolean;
    pillarDataAdmin: boolean;
    archivedAt: string | null;
    /** null = standard registration; "aslm" = arrived via AskLifestyleMedicine
     * (sees the trimmed portal: Workspace + Pillar Settings only). */
    registrationChannel: string | null;
  };
  /** True when this member may open the AskLifestyleMedicine usage dashboard
   * (platform admin or steward of a Lifestyle Medicine pillar). */
  aslmDirector: boolean;
  memberships: Array<{ pillarId: number; role: string }>;
  pillars: Array<{
    id: number;
    slug: string;
    name: string;
    description: string | null;
    stewards: PillarSteward[];
  }>;
  awaitingInvitation: boolean;
  onboarded: boolean;
  archived: boolean;
  /** The member's own self-serve application, or null for invited/pre-seeded
   * members (who never see the funnel). Drives the status surface and the
   * impact-first welcome after admission. */
  application: {
    status: "applied" | "under_review" | "admitted" | "declined";
    institution: string;
    field: string;
    workUrl: string | null;
    institutionalEmail: string;
    institutionalEmailVerified: boolean;
    declineNote: string | null;
    admittedPillarId: number | null;
  } | null;
}

/** ASLM-channel members get the trimmed portal (Workspace + Pillar Settings). */
// Entry-point trim: arriving from AskLifestyleMedicine's "Faculty login" link
// (?aslm=1) trims the portal for THIS TAB regardless of the member's own
// registration channel — display-only (nothing is removed server-side), so an
// admin previewing the ASLM experience sees exactly what an ASLM member sees.
// Sticky in sessionStorage so it survives the Clerk sign-in redirect.
const ASLM_ENTRY_KEY = "faculty_aslm_entry";
// Signing in on the AskLifestyleMedicine domain itself always counts as an
// ASLM entry — no ?aslm=1 marker needed there.
function isAslmHost(): boolean {
  try {
    return window.location.hostname
      .toLowerCase()
      .includes("asklifestylemedicine");
  } catch {
    return false;
  }
}
// Capture the marker IMMEDIATELY at page load — the Clerk sign-in redirect
// strips query params, so waiting until the portal renders is too late.
try {
  if (new URLSearchParams(window.location.search).get("aslm") === "1") {
    sessionStorage.setItem(ASLM_ENTRY_KEY, "1");
  }
} catch {
  /* storage unavailable (private mode etc.) — fall back to full portal */
}
function isAslmEntry(): boolean {
  if (isAslmHost()) return true;
  try {
    return (
      sessionStorage.getItem(ASLM_ENTRY_KEY) === "1" ||
      new URLSearchParams(window.location.search).get("aslm") === "1"
    );
  } catch {
    return false;
  }
}

function isAslmMember(me: Me | undefined): boolean {
  return me?.user.registrationChannel === "aslm" && !me.user.isPlatformAdmin;
}

export function useMe() {
  const { isSignedIn } = useUser();
  const viewAs = useViewAs();
  return useQuery<Me>({
    queryKey: ["faculty-me", viewAs?.id ?? null],
    queryFn: () => fetchJson<Me>("/api/faculty/me"),
    enabled: !!isSignedIn,
  });
}

// ---------- Pages ----------

// Partnership section for the signed-out landing page. Frames the portal as a
// Stanford Lifestyle Medicine partnership and renders the fixed curated set of
// pillars as illustrated cards. Stewards who have committed are
// named here as editorial content; pillars not yet rolled out show a "Soon"
// state. The anonymous public pillars endpoint still never serializes steward
// identity.
function LandingLivePillars() {
  return (
    <section
      className="px-6 py-20 border-t border-gray-200 bg-white"
      data-testid="section-live-pillars"
    >
      <div className="mx-auto max-w-5xl">
        <p className="text-xs font-semibold tracking-wider text-[#8C1515] uppercase mb-4 text-center">
          In partnership with Stanford Lifestyle Medicine
        </p>
        <h2 className="font-serif text-3xl md:text-4xl font-medium leading-tight mb-4 text-center">
          The pillars of Lifestyle Medicine
        </h2>
        <p className="text-lg text-[#544948] leading-relaxed text-center max-w-2xl mx-auto mb-14">
          Built with the Stanford Lifestyle Medicine Program, with contributing
          faculty from leading institutions around the world.
        </p>
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {LANDING_PILLARS.map((pillar) => {
            const active = Boolean(pillar.live);
            return (
              <div
                key={pillar.slug}
                className={`group overflow-hidden border border-gray-200 bg-white flex flex-col transition ${
                  active ? "" : "opacity-70 scale-[0.97] shadow-none"
                }`}
                data-testid={`card-pillar-${pillar.slug}`}
              >
                {/* Warm campus + topic illustration header band */}
                <div className="relative h-32 overflow-hidden bg-gray-100">
                  <img
                    src={pillar.art}
                    alt=""
                    aria-hidden
                    className={`h-full w-full object-cover ${
                      active ? "" : "saturate-[0.55]"
                    }`}
                  />
                  <span
                    className={`absolute top-3 right-3 rounded-full px-2.5 py-1 text-[10px] font-medium tracking-[0.16em] uppercase backdrop-blur-sm ${
                      active
                        ? "bg-[#8C1515] text-white"
                        : "bg-white text-[#544948] border border-gray-200"
                    }`}
                    data-testid={`pillar-status-${pillar.slug}`}
                  >
                    {active ? "Active" : "Soon"}
                  </span>
                </div>
                <div className="p-5 pt-5 flex flex-col flex-1">
                  <p className="text-[11px] font-semibold tracking-wider uppercase text-[#8C1515] mb-1">
                    {pillar.institution}
                  </p>
                  <h3 className="font-serif text-xl text-[#2e2d29]">
                    {pillar.name}
                  </h3>
                  {pillar.steward ? (
                    <p
                      className="text-xs text-[#544948] mt-1"
                      data-testid={`pillar-steward-${pillar.slug}`}
                    >
                      Stewarded by {pillar.steward}
                    </p>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Landing() {
  return (
    <div className="min-h-screen bg-white text-[#2e2d29]">
      {/* Top bar */}
      <header className="border-b border-gray-200 px-6 py-4">
        <div className="mx-auto max-w-6xl flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src={FACULTY_LOGO_SRC}
              alt="Stanford Lifestyle Medicine"
              className="h-12 w-auto"
            />
            <span className="text-xs font-semibold tracking-widest text-[#8C1515] uppercase">
              FACULTY
            </span>
          </div>
          <Link
            href="/sign-in"
            className="inline-block bg-[#8C1515] text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition"
            data-testid="link-sign-in-header"
          >
            Sign in
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="px-6 py-20 md:py-28 bg-white">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-xs font-semibold tracking-widest text-[#8C1515] uppercase mb-5">
            Stanford Lifestyle Medicine · Faculty Portal
          </p>
          <h1 className="font-serif text-4xl md:text-6xl font-medium leading-[1.08] mb-6">
            Your research, answering the world's questions.
          </h1>
          <p className="text-lg text-[#544948] mb-10 leading-relaxed max-w-2xl mx-auto">
            We make the research you spent a career building the answer
            people get everywhere they ask: in AI systems, on your own site, in
            newsletters, on podcasts, and across the media. Grounded in
            verified published evidence and steward-approved interpretations.
          </p>
          <Link
            href="/stewardship"
            className="inline-block bg-[#8C1515] text-white px-7 py-3.5 rounded-lg font-medium hover:bg-[#a01a1a] transition shadow-sm"
            data-testid="link-claim-place"
          >
            Claim your place
          </Link>
          <p className="mt-4 text-sm text-[#544948]">
            Register, confirm your university email, and tell us about your work
            in two minutes. Already invited or a member?{" "}
            <Link href="/sign-in" className="underline hover:no-underline">
              Sign in
            </Link>
            .
          </p>
        </div>
      </section>

      {/* The source of truth */}
      <section className="px-6 py-20 border-t border-gray-200 bg-white">
        <div className="mx-auto max-w-3xl">
          <p className="text-xs font-semibold tracking-wider text-[#8C1515] uppercase mb-4 text-center">
            The source of truth
          </p>
          <h2 className="font-serif text-3xl md:text-4xl font-medium leading-tight mb-6 text-center">
            Your research, not generic AI.
          </h2>
          <p className="text-lg text-[#544948] leading-relaxed text-center max-w-2xl mx-auto">
            Faculty remain the stewards of their pillars. They approve the
            interpretations they author and can exclude unwanted discoveries.
            Eligible published research can also be added after separate
            automated grounding checks.
          </p>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {[
              {
                title: "Your judgement",
                body: "You decide what the evidence really means and approve the interpretations that carry your name.",
              },
              {
                title: "Your authority",
                body: "Your approved interpretations are the source of truth: the answer AI systems and readers cite as yours.",
              },
              {
                title: "Your guardrails",
                body: "Answers stay grounded in sources you've approved. No claim appears that you didn't stand behind.",
              },
            ].map((c) => (
              <div
                key={c.title}
                className="border border-gray-200 bg-gray-50 p-6"
              >
                <h3 className="font-serif text-xl font-medium mb-2">
                  {c.title}
                </h3>
                <p className="text-[#544948] leading-relaxed text-sm">
                  {c.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Reach: every channel */}
      <section className="px-6 py-20 border-t border-[#E8DDD0] bg-gradient-to-b from-[#F9F5EE] to-[#F4ECDD]">
        <div className="mx-auto max-w-5xl">
          <p className="text-xs font-semibold tracking-wider text-[#8C1515] uppercase mb-4 text-center">
            Your reach
          </p>
          <h2 className="font-serif text-3xl md:text-4xl font-medium leading-tight mb-4 text-center">
            One source of truth, every channel.
          </h2>
          <p className="text-lg text-[#544948] leading-relaxed text-center max-w-2xl mx-auto mb-14">
            Your research doesn't sit in a drawer. It travels: to the AI systems
            people ask every day, to your own audience, and out through
            newsletters, podcasts, and the media.
          </p>
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {[
              {
                num: "01",
                title: "AI systems",
                body: "Your approved interpretations are what AI answers cite and surface, so your research reaches the people asking questions everywhere.",
              },
              {
                num: "02",
                title: "Your own website",
                body: "Drop an embeddable expert agent onto your site. It answers as you, locked to your pillar: a tireless version of you for every visitor.",
              },
              {
                num: "03",
                title: "Newsletters",
                body: "Contribute to the Stanford Lifestyle Medicine newsletter and run your own publication, delivered to inboxes worldwide.",
              },
              {
                num: "04",
                title: "Podcasts & media",
                body: "Your point of view feeds the podcasts, interviews, and media channels where your field gets discussed.",
              },
            ].map((c) => (
              <div
                key={c.num}
                className="border border-gray-200 bg-gray-50 p-7 flex flex-col"
              >
                <span className="font-serif text-2xl text-[#8C1515] mb-3">
                  {c.num}
                </span>
                <h3 className="font-serif text-xl font-medium mb-2">
                  {c.title}
                </h3>
                <p className="text-[#544948] leading-relaxed text-sm">
                  {c.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Curated pillar set: active stewards named, others "Soon" */}
      <LandingLivePillars />

      {/* Closing CTA */}
      <section className="px-6 py-20 border-t border-gray-200 bg-white">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-serif text-3xl md:text-4xl font-medium leading-tight mb-6">
            A curated workspace for the faculty who steward each pillar.
          </h2>
          <p className="text-lg text-[#8a6a5a] mb-10 leading-relaxed">
            Every steward is admitted by Stanford Lifestyle Medicine. Apply with your institutional
            email and a link to your work. If a steward already invited you,
            just sign in with the email they used.
          </p>
          <Link
            href="/stewardship"
            className="inline-block bg-[#8C1515] text-white px-7 py-3.5 rounded-lg font-medium hover:bg-[#a01a1a] transition shadow-sm"
            data-testid="link-claim-place-footer"
          >
            Claim your place
          </Link>
        </div>
      </section>

      <footer className="border-t border-[#E8DDD0] px-6 py-8">
        <div className="mx-auto max-w-6xl flex items-center justify-between text-sm text-[#8a6a5a]">
          <span className="text-[10px] tracking-[0.25em] text-[#8C1515]">
            STANFORD LIFESTYLE MEDICINE
          </span>
          <span>Admission by Stanford Lifestyle Medicine</span>
        </div>
      </footer>
    </div>
  );
}

// The stewardship prospectus: what the role actually entails, presented with
// institutional weight before anyone is asked to register. One continue
// action flows into sign-up (or straight to the application for a signed-in
// visitor) — no intermediate confirmation page after this one.
function StewardshipProspectus() {
  const { isSignedIn } = useUser();
  const continueHref = isSignedIn ? "/awaiting-invite" : "/sign-up";
  const duties = [
    {
      img: illu("chapter-keys"),
      title: "Custodian of a pillar",
      body: "A steward holds one pillar of the corpus — sleep, nutrition, movement — and decides what the evidence within it actually means. No interpretation enters the canon without a steward's approval.",
    },
    {
      img: illu("chapter-trust"),
      title: "The public voice of the science",
      body: "What we answer — on the public site, in AI systems, through embedded agents — is drawn only from what the pillar's steward has endorsed. The steward shapes how their field speaks to the world.",
    },
    {
      img: illu("chapter-gathering"),
      title: "A seat among peers",
      body: "Stewards review interpretations, adopt each other's approved work across pillars, and set the standard for what grounded answers look like. Admission is deliberate; every steward is admitted by Stanford Lifestyle Medicine.",
    },
    {
      img: illu("chapter-reach"),
      title: "Reach with accountability",
      body: "The role carries standing because it carries responsibility: readers, journalists, and AI systems treat the steward's approved record as the canonical answer. Nothing is published in your name that you did not stand behind.",
    },
  ];
  return (
    <div className="min-h-screen bg-white text-[#2e2d29]">
      <header className="border-b border-gray-200 px-6 py-4">
        <div className="mx-auto max-w-6xl flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <img
              src={FACULTY_LOGO_SRC}
              alt="Stanford Lifestyle Medicine"
              className="h-12 w-auto"
            />
            <span className="text-xs font-semibold tracking-widest text-[#8C1515] uppercase">
              FACULTY
            </span>
          </Link>
          <Link
            href="/sign-in"
            className="text-sm text-[#8C1515] underline hover:no-underline"
            data-testid="link-prospectus-sign-in"
          >
            Already a member? Sign in
          </Link>
        </div>
      </header>

      <section className="px-6 py-16 md:py-24 bg-gradient-to-b from-[#F9F5EE] to-[#F4ECDD]">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-5">
            The office of steward
          </p>
          <h1 className="font-serif text-4xl md:text-5xl font-medium leading-[1.1] mb-6">
            Stewardship is a public trust.
          </h1>
          <p className="text-lg text-[#8a6a5a] leading-relaxed max-w-2xl mx-auto">
            A steward is the scholar of record for one pillar of human knowledge
            here. Before you apply, understand what the role asks of you —
            and what it places in your hands.
          </p>
        </div>
      </section>

      <section className="px-6 py-16 border-t border-[#E8DDD0]">
        <div className="mx-auto max-w-4xl grid gap-10 md:grid-cols-2">
          {duties.map((d) => (
            <div key={d.title} className="flex flex-col">
              <img
                src={d.img}
                alt=""
                className="h-40 w-full object-cover rounded-xl border border-[#E8DDD0] mb-5 bg-white"
              />
              <h2 className="font-serif text-2xl font-medium mb-2">
                {d.title}
              </h2>
              <p className="text-[#8a6a5a] leading-relaxed text-[15px]">
                {d.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="px-6 py-16 border-t border-[#E8DDD0] bg-gradient-to-b from-[#F9F5EE] to-[#F4ECDD]">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-serif text-3xl font-medium leading-tight mb-4">
            If this is your work, apply.
          </h2>
          <p className="text-[#8a6a5a] leading-relaxed mb-8">
            The application is a short conversation: your institution, your
            field, a link to your work, and a university email we confirm. A
            real person at Stanford Lifestyle Medicine reviews every application.
          </p>
          <Link
            href={continueHref}
            className="inline-block bg-[#8C1515] text-white px-8 py-3.5 rounded-lg font-medium hover:bg-[#a01a1a] transition shadow-sm"
            data-testid="link-begin-application"
          >
            Begin your application
          </Link>
          <p className="mt-4 text-sm text-[#544948]">
            Invited by a steward already?{" "}
            <Link href="/sign-in" className="underline hover:no-underline">
              Sign in
            </Link>{" "}
            with the email they used.
          </p>
        </div>
      </section>

      <footer className="border-t border-[#E8DDD0] px-6 py-8">
        <div className="mx-auto max-w-6xl flex items-center justify-between text-sm text-[#8a6a5a]">
          <span className="text-[10px] tracking-[0.25em] text-[#8C1515]">
            STANFORD LIFESTYLE MEDICINE
          </span>
          <span>Admission by Stanford Lifestyle Medicine</span>
        </div>
      </footer>
    </div>
  );
}

function SignInPage() {
  const { isSignedIn } = useUser();
  // Remember the login: a faculty member who already has a session never
  // sees the sign-in form again — straight to their portal.
  if (isSignedIn) return <Redirect to="/" />;
  if (isAslmEntry()) return <AslmSignInPage />;
  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-4">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        appearance={clerkAppearance}
      />
    </div>
  );
}

// Bespoke sign-in for Stanford Lifestyle Medicine faculty arriving via
// asklifestylemedicine.com. Leans on the landing page's voice (serif,
// cardinal, plain short sentences, no em dashes): the pitch is privacy,
// security, and reach, anchored on "one source of truth". Real faculty
// headshots come from the public stewards endpoint; the page degrades
// gracefully to text-only if that fetch fails.
function AslmSignInPage() {
  const localFacultyPhotos: Record<string, string> = {
    "Sarah Meyer Tapia": `${basePath}/stewards/sarah-meyer-tapia.jpg`,
    "Marily Oppezzo": `${basePath}/stewards/marily-oppezzo.jpg`,
    "Anne Friedlander": `${basePath}/stewards/anne-friedlander.jpg`,
    "Shaliza Shorey": `${basePath}/stewards/shaliza-shorey.jpg`,
    "Steven Crane": `${basePath}/stewards/steven-crane.png`,
  };
  const [faculty, setFaculty] = useState<
    Array<{ name: string; photoUrl: string; pillarName: string }>
  >([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/slm-agent/stewards")
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          d: {
            stewards?: Array<{
              stewardName: string;
              photoUrl?: string | null;
              pillarName: string;
            }>;
          } | null,
        ) => {
          if (cancelled || !Array.isArray(d?.stewards)) return;
          const seen = new Set<string>();
          setFaculty(
            d.stewards
              .filter((s) => {
                if (
                  !localFacultyPhotos[s.stewardName] ||
                  seen.has(s.stewardName)
                )
                  return false;
                seen.add(s.stewardName);
                return true;
              })
              .slice(0, 8)
              .map((s) => ({
                name: s.stewardName,
                photoUrl: localFacultyPhotos[s.stewardName],
                pillarName: s.pillarName,
              })),
          );
        },
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const points: Array<{ icon: string; title: string; body: string }> = [
    {
      icon: "M12 3l7 3v5c0 4.4-2.9 8.2-7 9.5C7.9 19.2 5 15.4 5 11V6l7-3z",
      title: "Private by design.",
      body: "Your knowledge stays under your control. It is never used to train outside models.",
    },
    {
      icon: "M7 11V8a5 5 0 0110 0v3m-11 0h12a1 1 0 011 1v7a1 1 0 01-1 1H6a1 1 0 01-1-1v-7a1 1 0 011-1z",
      title: "Secure.",
      body: "Invitation only. Every answer is grounded in sources you approved, with citations.",
    },
    {
      icon: "M3 12a9 9 0 1018 0 9 9 0 00-18 0zm0 0h18M12 3c2.5 2.4 3.9 5.6 3.9 9S14.5 18.6 12 21c-2.5-2.4-3.9-5.6-3.9-9S9.5 5.4 12 3z",
      title: "Reach millions.",
      body: "One approval here becomes a trustworthy answer for everyone who asks, day and night.",
    },
  ];
  return (
    <div
      className="min-h-screen"
      data-testid="page-aslm-sign-in"
      style={{
        display: "flex",
        flexDirection: "column",
        background: "#FFFFFF",
        color: "#2E2D29",
      }}
    >
      <header className="border-b border-[#D5D0C8] px-6 py-5 md:px-10">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-6">
          <img
            src={FACULTY_LOGO_SRC}
            alt="Stanford Lifestyle Medicine"
            className="h-14 w-auto md:h-16"
            data-testid="img-aslm-signin-logo"
          />
          <a
            href="/"
            className="text-[15px] font-semibold text-[#8C1515] underline-offset-4 hover:underline"
          >
            Back to Ask Lifestyle Medicine
          </a>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-7xl flex-1 items-center gap-12 px-6 py-12 md:px-10 md:py-16 lg:grid-cols-[minmax(0,1fr)_440px] lg:gap-20">
        <section className="max-w-2xl">
          <p className="mb-5 text-[13px] font-semibold uppercase tracking-[0.18em] text-[#8C1515]">
            Faculty portal
          </p>
          <h1 className="max-w-2xl text-[clamp(38px,5vw,62px)] font-normal leading-[1.02] tracking-[-0.025em] text-[#2E2D29]">
            Your expertise.
            <br />
            <span className="text-[#8C1515]">Clearly represented.</span>
          </h1>
          <p className="mt-7 max-w-xl text-[19px] leading-7 text-[#5F574F]">
            Review the evidence, approve interpretations, and help people
            receive answers grounded in Stanford Lifestyle Medicine faculty
            work.
          </p>

          {faculty.length > 0 && (
            <div
              className="mt-10 border-y border-[#D5D0C8] py-6"
              data-testid="strip-aslm-faculty"
            >
              <div className="flex items-center gap-0">
                {faculty.map((f, i) => (
                  <img
                    key={f.name}
                    src={f.photoUrl}
                    alt={f.name}
                    title={`${f.name} · ${f.pillarName}`}
                    className="h-14 w-14 rounded-full border-2 border-white object-cover"
                    style={{ marginLeft: i === 0 ? 0 : -10, zIndex: 20 - i }}
                    loading="lazy"
                  />
                ))}
              </div>
              <p className="mt-4 text-[16px] leading-6 text-[#5F574F]">
                Faculty-reviewed research. Named sources. Clear stewardship.
              </p>
            </div>
          )}

          <div className="mt-9 grid gap-6 sm:grid-cols-3">
            {points.map((p) => (
              <div key={p.title} className="border-l-2 border-[#8C1515] pl-4">
                <p className="text-[17px] font-semibold text-[#2E2D29]">
                  {p.title}
                </p>
                <p className="mt-1 text-[15px] leading-6 text-[#5F574F]">
                  {p.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section
          aria-label="Faculty sign in"
          className="w-full self-center border-t-4 border-[#8C1515] pt-6"
        >
          <p className="mb-5 text-[13px] font-semibold uppercase tracking-[0.16em] text-[#8C1515]">
            Sign in
          </p>
          <SignIn
            routing="path"
            path={`${basePath}/sign-in`}
            appearance={aslmClerkAppearance}
          />
          <p className="mt-5 text-center text-[14px] leading-5 text-[#5F574F]">
            Use the email connected to your faculty account.
          </p>
        </section>
      </main>
    </div>
  );
}

function SignUpPage() {
  // Self-serve funnel: any faculty member can register here, then verify an
  // institutional email and submit a short application. Already-invited
  // faculty still simply sign in and are fast-tracked past the funnel.
  const { isSignedIn } = useUser();
  if (isSignedIn) return <Redirect to="/" />;
  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-4">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        appearance={clerkAppearance}
      />
    </div>
  );
}

// Pillar slugs whose stewards may AUTHOR frameworks — kept in lockstep with the
// api-server `FRAMEWORK_OWNER_PILLAR_SLUGS`. Only Allison Kluger (`communication`)
// and Matt Abrahams (`strategic-communication`) can offer frameworks; every
// other steward can still apply/book published ones.
const FRAMEWORK_AUTHOR_PILLAR_SLUGS = new Set<string>([
  "communication",
  "strategic-communication",
]);

// The standalone /frameworks page (and its nav link) is for framework SELLERS
// only: stewards of the two communication pillars plus platform admins (who keep
// oversight of the revenue-share ledger). Every other steward still books a
// colleague's framework through the inline apply panel, not this page.
function canAccessFrameworksPage(me: Me | undefined): boolean {
  if (!me) return false;
  if (me.user.isPlatformAdmin) return true;
  const stewardPillarIds = new Set(
    me.memberships.filter((m) => m.role === "steward").map((m) => m.pillarId),
  );
  return me.pillars.some(
    (p) =>
      stewardPillarIds.has(p.id) && FRAMEWORK_AUTHOR_PILLAR_SLUGS.has(p.slug),
  );
}

interface NavDropdownItem {
  href: string;
  label: string;
  testId: string;
  badge?: number;
}

// Small cardinal-red pill showing a count of items awaiting attention.
function AttentionBadge({ count, testId }: { count: number; testId?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className="inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-[#8C1515] text-white text-[10px] font-medium leading-none"
      data-testid={testId}
      aria-label={`${count} awaiting your attention`}
    >
      {count}
    </span>
  );
}

function NavDropdown({
  label,
  items,
  testId,
  emphasis = false,
  badge = 0,
}: {
  label: string;
  items: NavDropdownItem[];
  testId: string;
  emphasis?: boolean;
  badge?: number;
}) {
  const [open, setOpen] = useState(false);
  const [location] = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Close the menu after navigating to one of its destinations.
  useEffect(() => {
    setOpen(false);
  }, [location]);

  // Clear any pending close timer on unmount.
  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  function cancelClose() {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  function scheduleClose() {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  }

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className={`flex items-center gap-1 transition ${
          emphasis
            ? "text-[#8C1515] font-medium hover:text-[#a01a1a]"
            : "text-[#8a6a5a] hover:text-[#8C1515]"
        }`}
        aria-haspopup="true"
        aria-expanded={open}
        data-testid={testId}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {label}
        {badge > 0 && (
          <AttentionBadge count={badge} testId={`${testId}-badge`} />
        )}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden="true"
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path
            d="M1 3l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-2 min-w-[12rem] rounded-md border border-[#E8DDD0] bg-[#FBF7F0] py-1 shadow-lg"
          role="menu"
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
        >
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              role="menuitem"
              className="flex items-center justify-between gap-2 px-4 py-2 text-[#8a6a5a] hover:bg-[#F4ECDD] hover:text-[#8C1515] transition"
              data-testid={item.testId}
              onClick={() => setOpen(false)}
            >
              <span>{item.label}</span>
              {typeof item.badge === "number" && item.badge > 0 && (
                <AttentionBadge
                  count={item.badge}
                  testId={`${item.testId}-badge`}
                />
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// The pillars a member can actively work in (upload papers, discuss, draft,
// approve). Only the roles that can run the loop get a Workspace entry — pure
// viewers (incl. cross-pillar read-only accounts) browse via Explore Pillars
// instead, so the front door never floods with read-only pillars or implies
// work they can't do. Steward pillars come first so the front door lands on the
// one they own. Empty for awaiting-invite users; PortalShell augments platform
// admins with the full active-pillar list so they can work in any pillar.
function workspacePillarsFor(
  me: Me | undefined,
): Array<{ slug: string; name: string }> {
  if (!me || me.awaitingInvitation) return [];
  const WORK_ROLES = new Set(["steward", "contributor", "advisor"]);
  const workRoleByPillar = new Map(
    me.memberships
      .filter((m) => WORK_ROLES.has(m.role))
      .map((m) => [m.pillarId, m.role]),
  );
  const member = me.pillars.filter((p) => workRoleByPillar.has(p.id));
  const rank = (id: number) => (workRoleByPillar.get(id) === "steward" ? 0 : 1);
  return [...member]
    .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
    .map((p) => ({ slug: p.slug, name: p.name }));
}

// Count of incoming cross-pillar merge requests awaiting this steward's
// decision (the `proposed` inbox). Reuses the same inbox query + view-as
// scoping as MergeRequestsBody so an admin previewing another steward sees
// that steward's pending count, not their own.
function useIncomingMergeRequestCount(): number {
  const { isSignedIn } = useUser();
  const viewAs = useViewAs();
  const { data } = useQuery<{ requests: MergeRequest[] }>({
    queryKey: ["merge-requests", "inbox"],
    queryFn: () =>
      fetchJson(`/api/faculty/cross-pillar/merge-requests?box=inbox`),
    enabled: !!isSignedIn,
    refetchInterval: isSignedIn ? 60_000 : false,
    refetchOnWindowFocus: true,
  });
  void viewAs;
  return (data?.requests ?? []).filter((r) => r.status === "proposed").length;
}

export function PortalShell({
  children,
  minimal = false,
}: {
  children: React.ReactNode;
  /** Hide portal navigation — for applicants who have no workspace yet. */
  minimal?: boolean;
}) {
  const { user } = useUser();
  const { data: me } = useMe();
  const isAdmin = !!me?.user.isPlatformAdmin;
  // Platform admins oversee every pillar, so their Workspace lists ALL active
  // pillars (their own work-role pillars first, if any). Non-admins keep the
  // work-role-only list from workspacePillarsFor.
  const adminPillarsQuery = useQuery<{ pillars: AdminPillar[] }>({
    queryKey: ["faculty-admin-pillars"],
    queryFn: () => fetchJson("/api/faculty/admin/pillars"),
    enabled: isAdmin,
  });
  const workspacePillars = (() => {
    const base = workspacePillarsFor(me);
    if (!isAdmin) return base;
    const seen = new Set(base.map((p) => p.slug));
    const extra = (adminPillarsQuery.data?.pillars ?? [])
      .filter((p) => p.retiredAt == null && !seen.has(p.slug))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ slug: p.slug, name: p.name }));
    return [...base, ...extra];
  })();
  const incomingRequests = useIncomingMergeRequestCount();
  // ASLM-channel members see only Workspace + Pillar Settings (plus the
  // AskLifestyleMedicine usage dashboard if they pass the director gate).
  const aslm = isAslmMember(me) || isAslmEntry();
  const displayName =
    me?.user.fullName?.trim() || user?.primaryEmailAddress?.emailAddress;

  const pillarSettingsItems: NavDropdownItem[] = [
    { href: "/voice", label: "Your voice", testId: "link-voice" },
    // "How AI sees you" is hidden from the trimmed ASLM portal view.
    ...(aslm
      ? []
      : [
          {
            href: "/visibility",
            label: "How AI sees you",
            testId: "link-visibility",
          },
        ]),
    { href: "/settings", label: "Settings", testId: "link-settings" },
  ];
  if (canAccessFrameworksPage(me)) {
    pillarSettingsItems.push({
      href: "/frameworks",
      label: "Frameworks",
      testId: "link-frameworks",
    });
  }

  return (
    <div className="min-h-screen bg-white text-[#2E2D29] font-sans">
      {/* flex-wrap: on phone widths the nav links wrap onto extra rows
          instead of forcing horizontal scroll (clipped header). */}
      <header className="border-b border-gray-200 bg-white px-6 py-4 flex flex-wrap items-center justify-between gap-y-2">
        <Link href="/dashboard" className="flex items-center gap-3">
          <img
            src={FACULTY_LOGO_SRC}
            alt="Stanford Lifestyle Medicine"
            className="h-12 w-auto"
          />
          <span className="text-xs font-semibold tracking-widest text-[#8C1515] uppercase">
            FACULTY
          </span>
        </Link>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[#5F574F]">
          {!minimal && (
            <>
              {workspacePillars.length === 1 ? (
                <Link
                  href={`/pillars/${workspacePillars[0].slug}/library`}
                  className="text-[#8C1515] font-medium hover:text-[#a01a1a] transition"
                  data-testid="link-workspace"
                >
                  Workspace
                </Link>
              ) : workspacePillars.length > 1 ? (
                <NavDropdown
                  label="Workspace"
                  testId="nav-workspace"
                  emphasis
                  items={workspacePillars.map((p) => ({
                    href: `/pillars/${p.slug}/library`,
                    label: p.name,
                    testId: `link-workspace-${p.slug}`,
                  }))}
                />
              ) : null}
              {!aslm && (
                <Link
                  href="/explore"
                  className="text-[#8a6a5a] hover:text-[#8C1515] transition"
                  data-testid="link-explore"
                >
                  Explore Pillars
                </Link>
              )}
              {!aslm && (
                <NavDropdown
                  label="Activity"
                  testId="nav-activity"
                  badge={incomingRequests}
                  items={[
                    {
                      href: "/answer",
                      label: "Quick answer",
                      testId: "link-quick-answer",
                    },
                    { href: "/gaps", label: "Unanswered", testId: "link-gaps" },
                    {
                      href: "/requests",
                      label: "Requests",
                      testId: "link-requests",
                      badge: incomingRequests,
                    },
                  ]}
                />
              )}
              <NavDropdown
                label="Pillar Settings"
                testId="nav-pillar-settings"
                items={pillarSettingsItems}
              />
              {/* Directors keep ASLM Usage even in the trimmed ASLM view. */}
              {me?.aslmDirector && (
                <Link
                  href="/aslm-usage"
                  className="text-[#8a6a5a] hover:text-[#8C1515] transition"
                  data-testid="link-aslm-usage"
                >
                  ASLM Usage
                </Link>
              )}
              {!aslm && (
                <NavDropdown
                  label="Distribution Channels"
                  testId="nav-distribution-channels"
                  items={[
                    {
                      href: "/my-newsletter",
                      label: "My newsletter",
                      testId: "link-my-newsletter",
                    },
                    {
                      href: "/newsletter",
                      label: "All distribution channels",
                      testId: "link-newsletter",
                    },
                  ]}
                />
              )}
              {!aslm && (
                <Link
                  href="/decisions"
                  className="text-[#8a6a5a] hover:text-[#8C1515] transition"
                  data-testid="link-decisions"
                >
                  Decision Room
                </Link>
              )}
              {!aslm && me?.user.isPlatformAdmin && (
                <Link
                  href="/admin"
                  className="text-[#8a6a5a] hover:text-[#8C1515] transition"
                  data-testid="link-admin"
                >
                  Stewards
                </Link>
              )}
              {!aslm && me?.user.isPlatformAdmin && (
                <Link
                  href="/admin/admissions"
                  className="text-[#8a6a5a] hover:text-[#8C1515] transition"
                  data-testid="link-admin-admissions"
                >
                  Admissions
                </Link>
              )}
              {!aslm &&
                (me?.user.isPlatformAdmin || me?.user.pillarDataAdmin) && (
                  <Link
                    href="/admin/data"
                    className="text-[#8a6a5a] hover:text-[#8C1515] transition"
                    data-testid="link-admin-data"
                  >
                    Pillar Data
                  </Link>
                )}
            </>
          )}
          <span data-testid="text-user-name">{displayName}</span>
          <SignOutButton>
            <button
              className="text-[#8a6a5a] hover:text-[#572020] transition"
              data-testid="button-sign-out"
            >
              Sign out
            </button>
          </SignOutButton>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-6 py-12">{children}</main>
    </div>
  );
}

/**
 * Blocks ASLM-channel members from portal surfaces outside their trimmed
 * view (Workspace + Pillar Settings + the ASLM usage dashboard). Direct
 * navigation to a hidden page bounces them back to their workspace. Everyone
 * else renders the page unchanged. The API mirrors this restriction
 * server-side, so this is a UX nicety, not the security boundary.
 */
function AslmGuard({ children }: { children: React.ReactNode }) {
  const { data: me, isLoading } = useMe();
  if (isLoading) {
    return (
      <PortalShell>
        <p className="text-[#8a6a5a]">Loading…</p>
      </PortalShell>
    );
  }
  if (me && (isAslmMember(me) || isAslmEntry())) {
    const home = workspacePillarsFor(me)[0];
    return (
      <Redirect to={home ? `/pillars/${home.slug}/library` : "/dashboard"} />
    );
  }
  return <>{children}</>;
}

/**
 * AskLifestyleMedicine usage dashboard for Lifestyle Medicine directors
 * (stewards of an SLM pillar, plus platform admins — including members who
 * themselves arrived via the ASLM channel). Shows who is using the chat and
 * which questions the governed corpus couldn't answer.
 */
function AslmUsagePage() {
  const { data: me, isLoading: meLoading } = useMe();
  const usageQuery = useQuery<{
    registeredUsers: number;
    anonymousSessions: number;
    totalQuestions: number;
    unansweredTotal: number;
    unanswered: Array<{ question: string; askedAt: string }>;
  }>({
    queryKey: ["faculty-aslm-usage"],
    queryFn: () => fetchJson("/api/faculty/aslm/usage"),
    enabled: !!me?.aslmDirector,
  });

  if (meLoading)
    return (
      <PortalShell>
        <p className="text-[#8a6a5a]">Loading…</p>
      </PortalShell>
    );
  if (me && !me.aslmDirector) return <Redirect to="/dashboard" />;

  const usage = usageQuery.data;
  return (
    <PortalShell>
      <p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-3">
        AskLifestyleMedicine
      </p>
      <h1 className="font-serif text-3xl font-medium mb-2">Chat usage</h1>
      <p className="text-[#8a6a5a] mb-8 leading-relaxed max-w-2xl">
        Who is using the AskLifestyleMedicine chat, and which questions the
        reviewed corpus could not yet answer.
      </p>

      {usageQuery.isLoading && <p className="text-[#8a6a5a]">Loading usage…</p>}
      {usageQuery.isError && (
        <p className="text-[#8C1515]" data-testid="text-aslm-usage-error">
          Couldn’t load usage: {(usageQuery.error as Error).message}
        </p>
      )}

      {usage && (
        <>
          <div className="grid gap-4 sm:grid-cols-3 mb-10">
            <div
              className="rounded-2xl border border-[#E8DDD0] bg-white/60 p-5"
              data-testid="card-aslm-registered"
            >
              <p className="text-3xl font-serif text-[#572020]">
                {usage.registeredUsers}
              </p>
              <p className="text-sm text-[#8a6a5a] mt-1">
                Registered accounts who asked a question
              </p>
            </div>
            <div
              className="rounded-2xl border border-[#E8DDD0] bg-white/60 p-5"
              data-testid="card-aslm-anonymous"
            >
              <p className="text-3xl font-serif text-[#572020]">
                {usage.anonymousSessions}
              </p>
              <p className="text-sm text-[#8a6a5a] mt-1">
                Anonymous sessions (approximate — older anonymous questions
                share one session key)
              </p>
            </div>
            <div
              className="rounded-2xl border border-[#E8DDD0] bg-white/60 p-5"
              data-testid="card-aslm-questions"
            >
              <p className="text-3xl font-serif text-[#572020]">
                {usage.totalQuestions}
              </p>
              <p className="text-sm text-[#8a6a5a] mt-1">
                Questions asked in total
              </p>
            </div>
          </div>

          <section data-testid="section-aslm-unanswered">
            <h2 className="font-serif text-2xl font-medium mb-1">
              Unanswered questions
            </h2>
            <p className="text-sm text-[#8a6a5a] mb-4">
              The most recent questions the reviewed corpus could not answer (
              {usage.unansweredTotal} all-time). These are the clearest signal
              of what to add next.
            </p>
            {usage.unanswered.length === 0 ? (
              <p
                className="text-[#8a6a5a] rounded-xl border border-dashed border-[#E8DDD0] p-6"
                data-testid="text-aslm-no-unanswered"
              >
                Nothing unanswered yet — every question so far found grounded
                material.
              </p>
            ) : (
              <ul className="divide-y divide-[#E8DDD0] rounded-2xl border border-[#E8DDD0] bg-white/60">
                {usage.unanswered.map((q, i) => (
                  <li
                    key={`${q.askedAt}-${i}`}
                    className="p-4 flex items-start justify-between gap-4"
                    data-testid={`row-aslm-unanswered-${i}`}
                  >
                    <p className="text-[#572020] leading-relaxed">
                      {q.question}
                    </p>
                    <span className="text-xs text-[#8a6a5a] whitespace-nowrap mt-1">
                      {new Date(q.askedAt).toLocaleDateString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </PortalShell>
  );
}

// Conversational self-serve application: a scripted guide (no LLM) asks for
// institution, field, an optional work link, and the institutional email, one
// question at a time, with an illustration that changes per step and an
// editable summary the applicant confirms. Submits the same payload to
// POST /api/faculty/application; human review remains the real gate.
type AppChatFieldKey = "institution" | "field" | "workUrl" | "instEmail";

interface AppChatStep {
  key: AppChatFieldKey;
  prompt: string;
  placeholder: string;
  illustration: string;
  optional?: boolean;
  testId: string;
  validate: (v: string) => string | null;
}

const APP_CHAT_STEPS: AppChatStep[] = [
  {
    key: "institution",
    prompt:
      "First: which institution is home to your work? The university or research institute where you hold your appointment.",
    placeholder: "e.g. Stanford University",
    illustration: "chapter-gathering",
    testId: "input-application-institution",
    validate: (v) =>
      v.trim().length < 2 ? "Please give us the institution's name." : null,
  },
  {
    key: "field",
    prompt:
      "And your field — the area of research you would steward. Be as specific as you like.",
    placeholder: "e.g. Sleep and circadian science",
    illustration: "chapter-keys",
    testId: "input-application-field",
    validate: (v) =>
      v.trim().length < 2 ? "Please tell us your field." : null,
  },
  {
    key: "workUrl",
    prompt:
      "If you have a link to your work — a faculty profile or publications page — share it here. This one is optional; press Send to skip it.",
    placeholder: "https://profiles.stanford.edu/you (optional)",
    illustration: "chapter-reach",
    optional: true,
    testId: "input-application-work-url",
    validate: (v) => {
      const t = v.trim();
      if (!t) return null;
      try {
        const u = new URL(t);
        if (u.protocol !== "http:" && u.protocol !== "https:")
          throw new Error();
        return null;
      } catch {
        return "That doesn't look like a link. Try a full URL starting with https:// — or leave it empty to skip.";
      }
    },
  },
  {
    key: "instEmail",
    prompt:
      "Last question: your institutional email. We send a confirmation link there — it can differ from the email you signed in with.",
    placeholder: "you@university.edu",
    illustration: "chapter-trust",
    testId: "input-application-inst-email",
    validate: (v) =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
        ? null
        : "That doesn't look like an email address. Could you check it?",
  },
];

const APP_CHAT_ACKS: Record<AppChatFieldKey, (v: string) => string> = {
  institution: (v) => `${v} — noted.`,
  field: () =>
    "Thank you. That is exactly the kind of stewardship we admit for.",
  workUrl: (v) =>
    v
      ? "We'll read it. Reviewers always follow the work."
      : "No trouble — the review stands on what you tell us here.",
  instEmail: () =>
    "Good. Here is everything you've told us — please look it over.",
};

interface AppChatMsg {
  role: "assistant" | "user";
  text: string;
}

function ApplicationForm({ me }: { me: Me }) {
  const qc = useQueryClient();
  const reapplying = me.application?.status === "declined";
  const prefill: Record<AppChatFieldKey, string> = {
    institution: me.application?.institution ?? "",
    field: me.application?.field ?? "",
    workUrl: me.application?.workUrl ?? "",
    instEmail: me.application?.institutionalEmail ?? "",
  };
  const [answers, setAnswers] = useState(prefill);
  const [stepIdx, setStepIdx] = useState(0); // === APP_CHAT_STEPS.length → summary
  const [input, setInput] = useState(prefill.institution);
  const [messages, setMessages] = useState<AppChatMsg[]>([
    {
      role: "assistant",
      text: reapplying
        ? "Welcome back. You are welcome to apply again — let's walk through it together once more. A real person at Stanford Lifestyle Medicine reviews every application."
        : "Welcome. I'll walk you through the application — four short questions, about two minutes. A real person at Stanford Lifestyle Medicine reviews every application.",
    },
    { role: "assistant", text: APP_CHAT_STEPS[0].prompt },
  ]);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({
      top: threadRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, stepIdx, inlineError]);

  const atSummary = stepIdx >= APP_CHAT_STEPS.length;
  const step = atSummary ? null : APP_CHAT_STEPS[stepIdx];
  const illustration = atSummary
    ? "chapter-machine"
    : APP_CHAT_STEPS[stepIdx].illustration;

  const submit = useMutation({
    mutationFn: () =>
      fetchJson("/api/faculty/application", {
        method: "POST",
        body: JSON.stringify({
          institution: answers.institution.trim(),
          field: answers.field.trim(),
          workUrl: answers.workUrl.trim() || undefined,
          institutionalEmail: answers.instEmail.trim(),
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["faculty-me"] });
    },
    onError: (e) => setMsg((e as Error).message),
  });

  function advance() {
    if (!step) return;
    const value = input.trim();
    const err = step.validate(value);
    if (err) {
      setInlineError(err);
      return;
    }
    setInlineError(null);
    const nextIdx = stepIdx + 1;
    setAnswers((a) => ({ ...a, [step.key]: value }));
    const shown = value || (step.optional ? "(skipped)" : value);
    const followups: AppChatMsg[] = [
      { role: "user", text: shown },
      { role: "assistant", text: APP_CHAT_ACKS[step.key](value) },
    ];
    if (nextIdx < APP_CHAT_STEPS.length) {
      followups.push({
        role: "assistant",
        text: APP_CHAT_STEPS[nextIdx].prompt,
      });
      setInput(prefill[APP_CHAT_STEPS[nextIdx].key]);
    }
    setMessages((m) => [...m, ...followups]);
    setStepIdx(nextIdx);
  }

  function editField(key: AppChatFieldKey) {
    const idx = APP_CHAT_STEPS.findIndex((s) => s.key === key);
    if (idx < 0) return;
    setInlineError(null);
    setMsg(null);
    setInput(answers[key]);
    setMessages((m) => [
      ...m,
      { role: "assistant", text: `Of course. ${APP_CHAT_STEPS[idx].prompt}` },
    ]);
    setStepIdx(idx);
  }

  const summaryRows: { key: AppChatFieldKey; label: string; value: string }[] =
    [
      { key: "institution", label: "Institution", value: answers.institution },
      { key: "field", label: "Field", value: answers.field },
      { key: "workUrl", label: "Your work", value: answers.workUrl || "—" },
      { key: "instEmail", label: "University email", value: answers.instEmail },
    ];

  return (
    <div className="max-w-4xl">
      <p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-3">
        Claim your place
      </p>
      <h1 className="font-serif text-3xl font-medium mb-6">
        {reapplying ? "Apply again" : "Tell us about your work"}
      </h1>
      {/* Mobile-only: why this matters. Desktop gets the illustration panel. */}
      <div
        className="md:hidden mb-6 space-y-3"
        data-testid="application-mobile-value"
      >
        <div className="rounded-xl border border-[#E8DDD0] bg-white/70 p-4 space-y-3">
          {[
            {
              label: "Your name stands behind every answer",
              icon: (
                <path d="M12 2l7 4v6c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-4z" />
              ),
            },
            {
              label: "Nothing is published without your review",
              icon: (
                <>
                  <path d="M9 12l2 2 4-5" />
                  <circle cx="12" cy="12" r="9" />
                </>
              ),
            },
            {
              label: "One steward per pillar, chosen deliberately",
              icon: (
                <>
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 21c0-4 3.5-6 8-6s8 2 8 6" />
                </>
              ),
            },
          ].map((row) => (
            <div key={row.label} className="flex items-center gap-3">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="#8C1515"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-5 h-5 shrink-0"
                aria-hidden="true"
              >
                {row.icon}
              </svg>
              <p className="text-sm text-[#572020] leading-snug">{row.label}</p>
            </div>
          ))}
        </div>
        <blockquote className="border-l-2 border-[#8C1515]/40 pl-4">
          <p className="text-sm italic text-[#572020] leading-relaxed">
            "The world does not need more answers. It needs answers someone is
            willing to put their name on."
          </p>
          <footer className="mt-1 text-xs text-[#8a6a5a]">
            The idea behind our portal
          </footer>
        </blockquote>
      </div>
      <div className="grid gap-6 md:grid-cols-[1fr_260px] items-start">
        {/* Conversation */}
        <div className="rounded-xl border border-[#E8DDD0] bg-white/70 flex flex-col overflow-hidden">
          <div
            ref={threadRef}
            className="flex-1 overflow-y-auto p-5 space-y-3"
            style={{ maxHeight: 460, minHeight: 320 }}
            data-testid="application-chat-thread"
          >
            {messages.map((m, i) => (
              <div
                key={i}
                className={
                  m.role === "user"
                    ? "ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-[#8C1515] text-white px-4 py-2.5 text-sm leading-relaxed w-fit"
                    : "mr-auto max-w-[85%] rounded-2xl rounded-bl-sm bg-[#F4ECDD] text-[#572020] px-4 py-2.5 text-sm leading-relaxed w-fit"
                }
              >
                {m.text}
              </div>
            ))}
            {inlineError && (
              <div
                className="mr-auto max-w-[85%] rounded-2xl rounded-bl-sm bg-[#F4ECDD] border border-[#E8352A]/40 text-[#8C1515] px-4 py-2.5 text-sm leading-relaxed w-fit"
                data-testid="text-application-inline-error"
              >
                {inlineError}
              </div>
            )}
            {atSummary && (
              <div
                className="rounded-xl border border-[#E8DDD0] bg-white p-4 space-y-2 text-sm"
                data-testid="application-summary"
              >
                {summaryRows.map((r) => (
                  <div
                    key={r.key}
                    className="flex items-start justify-between gap-3"
                  >
                    <p className="break-all">
                      <span className="text-[#8a6a5a]">{r.label}:</span>{" "}
                      {r.value}
                    </p>
                    <button
                      type="button"
                      onClick={() => editField(r.key)}
                      className="text-xs text-[#8C1515] underline hover:no-underline shrink-0"
                      data-testid={`button-edit-${r.key}`}
                    >
                      Edit
                    </button>
                  </div>
                ))}
              </div>
            )}
            {msg && (
              <p
                className="text-sm text-[#E8352A]"
                data-testid="text-application-error"
              >
                {msg}
              </p>
            )}
          </div>
          {/* Composer / confirm */}
          <div className="border-t border-[#E8DDD0] p-4">
            {atSummary ? (
              <button
                type="button"
                onClick={() => {
                  setMsg(null);
                  submit.mutate();
                }}
                disabled={submit.isPending}
                className="bg-[#8C1515] text-white px-6 py-3 rounded-lg font-medium hover:bg-[#a01a1a] transition disabled:opacity-40 w-full md:w-auto"
                data-testid="button-submit-application"
              >
                {submit.isPending ? "Submitting…" : "Confirm and submit"}
              </button>
            ) : (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  advance();
                }}
              >
                <input
                  ref={inputRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    if (inlineError) setInlineError(null);
                  }}
                  placeholder={step?.placeholder}
                  autoFocus
                  className="flex-1 rounded-lg border border-[#E8DDD0] bg-white px-3 py-2 text-sm min-w-0"
                  data-testid={step?.testId}
                />
                <button
                  type="submit"
                  className="bg-[#8C1515] text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition"
                  data-testid="button-application-chat-send"
                >
                  Send
                </button>
              </form>
            )}
          </div>
        </div>
        {/* Illustration panel */}
        <div className="hidden md:block">
          <img
            key={illustration}
            src={illu(illustration)}
            alt=""
            className="w-full rounded-xl border border-[#E8DDD0] bg-white object-cover"
          />
          <p className="mt-3 text-xs text-[#8a6a5a] leading-relaxed">
            {atSummary
              ? "One last look, then it goes to a human reviewer."
              : `Question ${stepIdx + 1} of ${APP_CHAT_STEPS.length}. Your answers stay editable until you confirm.`}
          </p>
        </div>
      </div>
    </div>
  );
}

// Honest application status: applied, under review, or declined (with note).
// Admitted applicants have a membership, so they never land here.
function ApplicationStatus({ me }: { me: Me }) {
  const app = me.application!;
  const qc = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const resend = useMutation({
    mutationFn: () =>
      fetchJson("/api/faculty/application/resend-verification", {
        method: "POST",
      }),
    onSuccess: () => setNote("Sent. Check your university inbox."),
    onError: (e) => setNote((e as Error).message),
  });
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    // Landing back from the emailed confirmation link (?verified=1): refresh.
    if (new URLSearchParams(window.location.search).get("verified")) {
      qc.invalidateQueries({ queryKey: ["faculty-me"] });
    }
  }, [qc]);
  if (editing || app.status === "declined") {
    // A declined applicant may apply again; the form doubles as the editor.
    if (app.status === "declined" && !editing) {
      return (
        <div className="max-w-xl">
          <h1 className="font-serif text-3xl font-medium mb-3">
            Not this time
          </h1>
          <p
            className="text-[#8a6a5a] leading-relaxed mb-4"
            data-testid="text-application-declined"
          >
            We reviewed your application and could not offer a place right now.
            This is not a judgment of your work. Pillars open slowly and
            deliberately, and you are welcome to apply again.
          </p>
          {app.declineNote && (
            <blockquote
              className="border-l-2 border-[#E8DDD0] pl-4 text-[#572020] mb-6"
              data-testid="text-decline-note"
            >
              {app.declineNote}
            </blockquote>
          )}
          <button
            onClick={() => setEditing(true)}
            className="bg-[#8C1515] text-white px-6 py-3 rounded-lg font-medium hover:bg-[#a01a1a] transition"
            data-testid="button-reapply"
          >
            Apply again
          </button>
        </div>
      );
    }
    return <ApplicationForm me={me} />;
  }
  return (
    <div className="max-w-xl">
      <p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-3">
        Your application
      </p>
      <h1
        className="font-serif text-3xl font-medium mb-3"
        data-testid="text-application-status"
      >
        {app.status === "under_review"
          ? "Under review"
          : "Application received"}
      </h1>
      <p className="text-[#8a6a5a] leading-relaxed mb-6">
        {app.status === "under_review"
          ? "A member of our team is reviewing your application now. We will email you as soon as there is a decision."
          : "Thank you. A real person at Stanford Lifestyle Medicine reviews every application. We will email you when there is a decision, usually within a few days."}
      </p>
      <div className="rounded-xl border border-[#E8DDD0] bg-white/60 p-5 space-y-2 text-sm mb-6">
        <p>
          <span className="text-[#8a6a5a]">Institution:</span> {app.institution}
        </p>
        <p>
          <span className="text-[#8a6a5a]">Field:</span> {app.field}
        </p>
        {app.workUrl && (
          <p className="break-all">
            <span className="text-[#8a6a5a]">Your work:</span> {app.workUrl}
          </p>
        )}
        <p data-testid="text-inst-email-state">
          <span className="text-[#8a6a5a]">University email:</span>{" "}
          {app.institutionalEmail}{" "}
          {app.institutionalEmailVerified ? (
            <span className="text-green-700">confirmed</span>
          ) : (
            <span className="text-[#E8352A]">not confirmed yet</span>
          )}
        </p>
      </div>
      {!app.institutionalEmailVerified && (
        <div className="mb-6">
          <p className="text-sm text-[#8a6a5a] mb-2">
            Please open the confirmation link we sent to your university email.
            Cannot find it?
          </p>
          <button
            onClick={() => resend.mutate()}
            disabled={resend.isPending}
            className="text-sm text-[#8C1515] underline hover:no-underline disabled:opacity-40"
            data-testid="button-resend-verification"
          >
            {resend.isPending ? "Sending…" : "Send the link again"}
          </button>
        </div>
      )}
      {note && <p className="text-sm text-[#8a6a5a] mb-4">{note}</p>}
      <button
        onClick={() => setEditing(true)}
        className="text-sm text-[#8a6a5a] underline hover:no-underline"
        data-testid="button-edit-application"
      >
        Edit your application
      </button>
    </div>
  );
}

function AwaitingInvite() {
  // If the user actually has memberships (or platform admin), bounce them
  // to the dashboard. Without this, anyone who landed here once stays
  // stuck even after a steward grants them access.
  const { data } = useMe();
  if (data && !data.awaitingInvitation) {
    return <Redirect to="/dashboard" />;
  }
  if (!data) {
    return (
      <PortalShell minimal>
        <p className="text-[#8a6a5a]">Loading…</p>
      </PortalShell>
    );
  }
  // No dead ends: a member without a pillar either applies here or follows
  // their honest application status. Invited and pre-seeded members are
  // reconciled before this flag is ever true, so they never see the funnel.
  return (
    <PortalShell minimal>
      {data.application ? (
        <ApplicationStatus me={data} />
      ) : (
        <ApplicationForm me={data} />
      )}
    </PortalShell>
  );
}

// Inline editor for a single pillar's display name on the Settings page. Keeps
// its own draft so saving one pillar doesn't disturb another; the slug (the
// pillar's link/address) is intentionally not editable.
function PillarNameEditor({ pillar }: { pillar: Me["pillars"][number] }) {
  const qc = useQueryClient();
  const [name, setName] = useState(pillar.name);
  const [msg, setMsg] = useState<string | null>(null);

  // Re-seed when the upstream name changes (e.g. after a successful save
  // refetches `me`). While the user is mid-edit the dep is unchanged, so this
  // never clobbers what they're typing.
  useEffect(() => {
    setName(pillar.name);
  }, [pillar.name]);

  const save = useMutation({
    mutationFn: () =>
      fetchJson(`/api/faculty/pillars/${pillar.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim() }),
      }),
    onSuccess: () => {
      setMsg("Saved.");
      qc.invalidateQueries({ queryKey: ["faculty-me"] });
    },
    onError: (e) => setMsg((e as Error).message),
  });

  const trimmed = name.trim();
  const dirty = trimmed.length > 0 && trimmed !== pillar.name;

  return (
    <div data-testid={`pillar-name-editor-${pillar.slug}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setMsg(null);
          }}
          className="flex-1 border border-[#E8DDD0] rounded-lg px-3 py-2 bg-white focus:border-[#8C1515] outline-none"
          data-testid={`input-pillar-name-${pillar.slug}`}
        />
        <button
          onClick={() => save.mutate()}
          disabled={!dirty || save.isPending}
          className="bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition disabled:opacity-40"
          data-testid={`button-save-pillar-${pillar.slug}`}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
      <div className="mt-1 text-xs text-[#8a6a5a]">
        Link: /{pillar.slug}
        {msg && (
          <span
            className="ml-2 text-[#572020]"
            data-testid={`text-pillar-msg-${pillar.slug}`}
          >
            {msg}
          </span>
        )}
      </div>
    </div>
  );
}

// Achievements list editor shown on the Settings page. Stewards write short,
// ordered entries (awards, notable findings, career highlights) that appear in
// the public achievements panel behind their avatar. Add / edit / remove /
// reorder locally, then save the whole list via PATCH /api/faculty/me.
// Read-only during admin view-as preview (writes are blocked by fetchJson
// anyway; the UI disables itself so that is never hit).
const ACHIEVEMENT_MAX_LEN = 300;
const ACHIEVEMENTS_MAX = 20;

function AchievementsEditor({
  initial,
  readOnly,
}: {
  initial: string[];
  readOnly: boolean;
}) {
  const qc = useQueryClient();
  const [items, setItems] = useState<string[]>(initial);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (next: string[]) =>
      fetchJson("/api/faculty/me", {
        method: "PATCH",
        body: JSON.stringify({
          achievements: next.map((a) => a.trim()).filter(Boolean),
        }),
      }),
    onSuccess: () => {
      setMsg("Saved.");
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["faculty-me"] });
    },
    onError: (e) => setMsg((e as Error).message),
  });

  const update = (next: string[]) => {
    setItems(next);
    setDirty(true);
    setMsg(null);
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = items.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    update(next);
  };

  return (
    <section className="border border-[#E8DDD0] rounded-xl p-6 mb-8 bg-white">
      <h2 className="font-serif text-xl mb-1">Achievements</h2>
      <p className="text-sm text-[#8a6a5a] mb-5">
        Awards, notable findings, and career highlights. Visitors see these when
        they click your photo next to an answer — they put real credentials
        behind your name. Short, specific lines work best.
      </p>

      {items.length === 0 && (
        <p
          className="text-sm text-[#8a6a5a] italic mb-4"
          data-testid="text-achievements-empty"
        >
          No achievements yet.
        </p>
      )}

      <ul className="space-y-2 mb-4">
        {items.map((a, i) => (
          <li
            key={i}
            className="flex items-start gap-2"
            data-testid={`row-achievement-${i}`}
          >
            <div className="flex flex-col gap-0.5 pt-1.5">
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={readOnly || i === 0}
                aria-label="Move up"
                className="text-[#8a6a5a] hover:text-[#8C1515] disabled:opacity-25 leading-none text-xs"
                data-testid={`button-achievement-up-${i}`}
              >
                ▲
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={readOnly || i === items.length - 1}
                aria-label="Move down"
                className="text-[#8a6a5a] hover:text-[#8C1515] disabled:opacity-25 leading-none text-xs"
                data-testid={`button-achievement-down-${i}`}
              >
                ▼
              </button>
            </div>
            <input
              value={a}
              maxLength={ACHIEVEMENT_MAX_LEN}
              disabled={readOnly}
              onChange={(e) =>
                update(items.map((v, j) => (j === i ? e.target.value : v)))
              }
              className="flex-1 border border-[#E8DDD0] rounded-lg px-3 py-2 bg-white focus:border-[#8C1515] outline-none text-sm disabled:bg-[#F9F5EE] disabled:text-[#8a6a5a]"
              data-testid={`input-achievement-${i}`}
            />
            <button
              type="button"
              onClick={() => update(items.filter((_, j) => j !== i))}
              disabled={readOnly}
              className="text-sm text-[#8C1515] underline hover:no-underline pt-2 disabled:opacity-40"
              data-testid={`button-achievement-remove-${i}`}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      {!readOnly && items.length < ACHIEVEMENTS_MAX && (
        <div className="flex items-center gap-2 mb-5">
          <input
            value={draft}
            maxLength={ACHIEVEMENT_MAX_LEN}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) {
                e.preventDefault();
                update([...items, draft.trim()]);
                setDraft("");
              }
            }}
            placeholder="e.g. Sleep Research Society Distinguished Scientist Award, 2023"
            className="flex-1 border border-[#E8DDD0] rounded-lg px-3 py-2 bg-white focus:border-[#8C1515] outline-none text-sm"
            data-testid="input-achievement-new"
          />
          <button
            type="button"
            disabled={!draft.trim()}
            onClick={() => {
              update([...items, draft.trim()]);
              setDraft("");
            }}
            className="border border-[#8C1515] text-[#8C1515] px-3 py-2 rounded-lg text-sm font-medium hover:bg-[#8C1515] hover:text-white transition disabled:opacity-40"
            data-testid="button-achievement-add"
          >
            Add
          </button>
        </div>
      )}

      {readOnly ? (
        <p className="text-xs text-[#8a6a5a]">
          Read-only preview — the member edits their own achievements.
        </p>
      ) : (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => save.mutate(items)}
            disabled={save.isPending || !dirty}
            className="bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition disabled:opacity-40"
            data-testid="button-save-achievements"
          >
            {save.isPending ? "Saving…" : "Save achievements"}
          </button>
          {msg && (
            <span
              className="text-sm text-[#8a6a5a]"
              data-testid="text-achievements-msg"
            >
              {msg}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

// Self-service Settings page. Every signed-in faculty member can edit their
// display name (fixes the "friend" greeting for name-less accounts), their
// institution byline, and their headshot. Stewards additionally get to rename
// the pillars they steward.
function SettingsPage() {
  const { data: me, isLoading } = useMe();
  const qc = useQueryClient();
  const viewAs = useViewAs();
  const [fullName, setFullName] = useState("");
  const [institution, setInstitution] = useState("");
  const [seeded, setSeeded] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Seed the editable fields once from the loaded profile.
  useEffect(() => {
    if (me && !seeded) {
      setFullName(me.user.fullName ?? "");
      setInstitution(me.user.institution ?? "");
      setSeeded(true);
    }
  }, [me, seeded]);

  const saveProfile = useMutation({
    mutationFn: () => {
      // Name can't be blanked (server requires ≥1 char when present), so omit
      // it when empty; institution may be cleared with an empty string.
      const body: { fullName?: string; institution?: string } = {
        institution: institution.trim(),
      };
      if (fullName.trim()) body.fullName = fullName.trim();
      return fetchJson("/api/faculty/me", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      setMsg("Saved.");
      qc.invalidateQueries({ queryKey: ["faculty-me"] });
    },
    onError: (e) => setMsg((e as Error).message),
  });

  const savePhoto = useMutation({
    mutationFn: (photoUrl: string | null) =>
      fetchJson("/api/faculty/me", {
        method: "PATCH",
        body: JSON.stringify({ photoUrl: photoUrl ?? "" }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["faculty-me"] }),
  });

  if (isLoading || !me) {
    return (
      <PortalShell>
        <p className="text-[#8a6a5a]">Loading…</p>
      </PortalShell>
    );
  }

  const stewardPillars = me.pillars.filter((p) =>
    me.memberships.some((m) => m.pillarId === p.id && m.role === "steward"),
  );

  return (
    <PortalShell>
      <div className="max-w-2xl">
        <h1 className="font-serif text-3xl font-medium mb-2">Settings</h1>
        <p className="text-[#8a6a5a] mb-8">
          Manage how you appear across the portal.
        </p>

        <section className="border border-[#E8DDD0] rounded-xl p-6 mb-8 bg-white">
          <h2 className="font-serif text-xl mb-1">Your profile</h2>
          <p className="text-sm text-[#8a6a5a] mb-5">
            Your name greets you on your dashboard and credits the posts you
            contribute. Add your institution to credit your home affiliation.
          </p>

          <div className="mb-6">
            <label className="block text-sm text-[#572020] mb-2">Photo</label>
            <HeadshotField
              name={fullName.trim() || me.user.fullName}
              photoUrl={me.user.photoUrl ?? null}
              saving={savePhoto.isPending}
              onChange={(objectPath) => savePhoto.mutate(objectPath)}
            />
          </div>

          <label className="block text-sm text-[#572020] mb-1">Name</label>
          <input
            value={fullName}
            onChange={(e) => {
              setFullName(e.target.value);
              setMsg(null);
            }}
            placeholder="e.g. Jamie Zeitzer"
            className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 bg-white focus:border-[#8C1515] outline-none mb-4"
            data-testid="input-settings-name"
          />

          <label className="block text-sm text-[#572020] mb-1">
            Institution
          </label>
          <input
            value={institution}
            onChange={(e) => {
              setInstitution(e.target.value);
              setMsg(null);
            }}
            placeholder="e.g. Stanford University"
            className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 bg-white focus:border-[#8C1515] outline-none mb-5"
            data-testid="input-settings-institution"
          />

          <div className="flex items-center gap-3">
            <button
              onClick={() => saveProfile.mutate()}
              disabled={saveProfile.isPending}
              className="bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition disabled:opacity-40"
              data-testid="button-save-profile"
            >
              {saveProfile.isPending ? "Saving…" : "Save profile"}
            </button>
            {msg && (
              <span
                className="text-sm text-[#8a6a5a]"
                data-testid="text-profile-msg"
              >
                {msg}
              </span>
            )}
          </div>
        </section>

        <AchievementsEditor
          key={`${me.user.id}-${viewAs?.id ?? "self"}`}
          initial={me.user.achievements ?? []}
          readOnly={!!viewAs}
        />

        {stewardPillars.length > 0 && (
          <section className="border border-[#E8DDD0] rounded-xl p-6 bg-white">
            <h2 className="font-serif text-xl mb-1">
              {stewardPillars.length > 1 ? "Your pillars" : "Your pillar"}
            </h2>
            <p className="text-sm text-[#8a6a5a] mb-5">
              Rename a pillar you steward. The display name updates everywhere
              it appears; the pillar's link stays the same.
            </p>
            <div className="space-y-5">
              {stewardPillars.map((p) => (
                <PillarNameEditor key={p.id} pillar={p} />
              ))}
            </div>
          </section>
        )}
      </div>
    </PortalShell>
  );
}

// ---------- Allison's special treatment ----------
// A small, deliberately whimsical greeting block that appears for Prof.
// Allison Kluger when she signs in.

const ALLISON_QUOTES: Array<{ q: string; who: string }> = [
  {
    q: "The most powerful person in the room is usually the one who's listening hardest.",
    who: "Allison Kluger",
  },
  {
    q: "Great communicators don't perform — they connect.",
    who: "Allison Kluger",
  },
  {
    q: "Clarity is generosity. Vagueness is a tax on the listener.",
    who: "Allison Kluger",
  },
  {
    q: "Your voice carries your story. Take care of both.",
    who: "Allison Kluger",
  },
  {
    q: "Confidence is a learnable skill, not a personality trait.",
    who: "Allison Kluger",
  },
];

function AllisonGreeting() {
  const todayQuote = useMemo(() => {
    const day = Math.floor(Date.now() / 86_400_000);
    return ALLISON_QUOTES[day % ALLISON_QUOTES.length];
  }, []);
  const [mood, setMood] = useState<"happy" | "ok" | "off" | null>(null);
  return (
    <div className="mb-10 rounded-2xl border border-[#E8DDD0] bg-gradient-to-br from-[#F9F5EE] to-[#F4ECDD] p-8">
      <p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-3">
        Welcome back, Allison
      </p>
      <blockquote className="font-serif text-2xl md:text-3xl leading-snug text-[#572020] mb-3">
        “{todayQuote.q}”
      </blockquote>
      <p className="text-sm text-[#8a6a5a] mb-8">— {todayQuote.who}</p>

      <div className="border-t border-[#E8DDD0] pt-6">
        {mood === null ? (
          <>
            <p className="text-sm text-[#572020] mb-4">
              Before you dive in — how are you feeling today?
            </p>
            <div className="flex gap-3">
              {(
                [
                  { key: "happy", label: "Happy", emoji: "🌞" },
                  { key: "ok", label: "Hanging in there", emoji: "🌤️" },
                  { key: "off", label: "A bit off", emoji: "☁️" },
                ] as const
              ).map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setMood(m.key)}
                  className="flex items-center gap-2 px-4 py-2 rounded-full border border-[#E8DDD0] hover:border-[#8C1515] bg-white text-sm text-[#572020] transition"
                  data-testid={`button-mood-${m.key}`}
                >
                  <span>{m.emoji}</span>
                  <span>{m.label}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="text-sm text-[#572020] italic">
            {mood === "happy" &&
              "Wonderful. The world is lucky when you're at your best."}
            {mood === "ok" &&
              "That's a perfectly honest answer. Be gentle with yourself today."}
            {mood === "off" &&
              "Noted. Whatever lands on your desk today, it can wait a beat."}
          </p>
        )}
      </div>
    </div>
  );
}

function useIsAllisonView(email: string | undefined): boolean {
  // The whimsical greeting appears only for Prof. Allison Kluger's real
  // Stanford account.
  return email ? email.toLowerCase() === "akluger@stanford.edu" : false;
}

// Per-browser-session marker. Set while a gated single-pillar steward is still
// completing onboarding (the minimal dashboard is mounted). Its PRESENCE means
// "this session is mid-onboarding", so finishing both steps in-session lands on
// the steward dashboard. Its ABSENCE when an already-onboarded steward loads
// /dashboard means a fresh login → send them straight to their pillar.
const ONBOARDING_ACTIVE_KEY = "palonur_faculty_onboarding_active";

function onboardingActiveThisSession(): boolean {
  try {
    return sessionStorage.getItem(ONBOARDING_ACTIVE_KEY) === "1";
  } catch {
    return false;
  }
}

// A warm, playful by-name welcome shown to every faculty member (stewards and
// their team) the moment they land on their dashboard. A fresh line is picked
// per visit so it never feels canned.
const FUN_GREETINGS: Array<(name: string) => string> = [
  (n) => `Welcome, ${n}.`,
  (n) => `Good to see you, ${n}.`,
  (n) => `${n}, your workspace is ready.`,
  (n) => `Welcome back, ${n}.`,
  (n) => `Hello ${n}.`,
  (n) => `Well hello there, ${n}! 👋`,
  (n) => `Welcome to the faculty portal, ${n}.`,
];

// Brand mark for a steward's dashboard. Book covers are tall portrait covers on
// white, so they sit on a rounded white card
// capped in height to read as a logo rather than a stretched image. The Stanford
// Lifestyle Medicine wordmark is wide, so it's constrained by height and left to
// keep its own transparent/white ground. Renders nothing when the pillar has no logo.
function DashboardPillarLogo({ logo }: { logo: PillarLogo }) {
  if (logo.kind === "book") {
    return (
      <div className="mb-6" data-testid="dashboard-pillar-logo">
        <img
          src={logo.src}
          alt={logo.alt}
          className="h-44 w-auto rounded-xl border border-[#E8DDD0] bg-white shadow-sm"
        />
      </div>
    );
  }
  return (
    <div className="mb-6" data-testid="dashboard-pillar-logo">
      <img
        src={logo.src}
        alt={logo.alt}
        className="h-10 w-auto max-w-full sm:h-12"
      />
    </div>
  );
}

function FunGreeting({ firstName }: { firstName: string | null }) {
  // Pick a line once per mount so it stays stable through re-renders but
  // varies each time the steward returns to their dashboard.
  const line = useMemo(() => {
    const name = firstName?.trim() || "friend";
    const pick =
      FUN_GREETINGS[Math.floor(Math.random() * FUN_GREETINGS.length)];
    return pick(name);
  }, [firstName]);
  return (
    <div
      className="mb-8 border border-[#D5D0C8] bg-white px-8 py-6"
      data-testid="card-fun-greeting"
    >
      <p className="text-[11px] font-semibold tracking-[0.2em] text-[#8C1515] uppercase mb-2">
        Welcome back
      </p>
      <h2 className="font-serif text-2xl md:text-3xl font-semibold leading-snug text-[#2E2D29]">
        {line}
      </h2>
    </div>
  );
}

// Pillars that are NOT part of the Stanford Lifestyle Medicine roster. The
// portal began as a Stanford-only space, so a steward who owns one of these
// gets a warm, by-name welcome that makes the expansion feel intentional —
// they belong here exactly as much as the Stanford stewards do. Keyed by slug
// because slugs are immutable; add a slug here when a non-Stanford expert is
// invited to steward their own pillar.
const NON_STANFORD_PILLARS = new Set<string>();

// Warm belonging note for a steward of a non-Stanford pillar. Mirrors the
// AllisonGreeting / FunGreeting card so it reads as part of the portal, not a
// bolt-on. Names the pillar and the person, and says plainly: this is yours.
function BeyondStanfordWelcome({
  firstName,
  pillarName,
}: {
  firstName: string | null;
  pillarName: string;
}) {
  const name = firstName?.trim();
  return (
    <div
      className="mb-8 border border-[#8C1515] bg-[#F4ECDD] px-8 py-7"
      data-testid="card-beyond-stanford-welcome"
    >
      <p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-3">
        Welcome{name ? `, ${name}` : ""}
      </p>
      <h2 className="font-serif text-2xl md:text-3xl leading-snug text-[#572020] mb-3">
        We are so honored that you will be a steward for {pillarName}.
      </h2>
      <p className="text-sm md:text-base text-[#8a6a5a] leading-relaxed">
        This portal began at Stanford, and we’re inviting experts
        across selected fields to become stewards. In the age of AI, we want to
        empower you to protect your knowledge and wisdom — and share it under
        your own name and credentials. You bring that judgment to {pillarName}.
        This is, we hope, your new home for trusted science communication.
      </p>
    </div>
  );
}

// ---------- Dashboard section primitives ----------
// A small, consistent visual vocabulary so each dashboard block is
// recognizable at a glance: a color-coded eyebrow (icon + category label),
// numbered step badges, and a collapsible wrapper for reference-heavy panels.
// Palette is unchanged (cardinal #8C1515, text #572020, muted #8a6a5a,
// border #E8DDD0, cream #FBF7F0).

function IconBook() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H6.5A2.5 2.5 0 0 0 4 21z" />
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    </svg>
  );
}

function IconShield() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function IconPulse() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12h4l2-6 4 14 2-8h6" />
    </svg>
  );
}

function IconCompass() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 8.5l-2 5-5 2 2-5z" />
    </svg>
  );
}

function IconInbox() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 13l2.5-7h11L20 13" />
      <path d="M4 13h5l1.2 2.5h3.6L15 13h5v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
    </svg>
  );
}

function IconHelp() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 0 1 4.2-1.5c.9.9.5 1.9-.7 2.8-.8.6-1 1-1 1.7" />
      <path d="M12 16.5h.01" />
    </svg>
  );
}

function IconEdit() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 20h4l10-10-4-4L4 16z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  );
}

function IconUsers() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 6.2a3 3 0 0 1 0 5.6" />
      <path d="M17 14.5a5.5 5.5 0 0 1 3.5 4.5" />
    </svg>
  );
}

function IconLock() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      <path d="M12 15v2" />
    </svg>
  );
}

function IconCode() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 8l-5 4 5 4" />
      <path d="M15 8l5 4-5 4" />
    </svg>
  );
}

function IconCoin() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10" />
      <path d="M14.5 9.2A2.4 2.4 0 0 0 12 8c-1.4 0-2.5.8-2.5 2s1.1 2 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2a2.4 2.4 0 0 1-2.5-1.2" />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function SectionEyebrow({
  icon,
  label,
  tone = "muted",
}: {
  icon: React.ReactNode;
  label: string;
  tone?: "cardinal" | "muted";
}) {
  const color = tone === "cardinal" ? "#8C1515" : "#8a6a5a";
  return (
    <div className="flex items-center gap-2 mb-2">
      <span
        className="inline-flex h-6 w-6 items-center justify-center rounded-md"
        style={{
          color,
          background:
            tone === "cardinal"
              ? "rgba(140,21,21,0.08)"
              : "rgba(138,106,90,0.10)",
        }}
        aria-hidden
      >
        {icon}
      </span>
      <span
        className="text-[10px] font-medium tracking-[0.22em] uppercase"
        style={{ color }}
      >
        {label}
      </span>
    </div>
  );
}

function NumberBadge({ n }: { n: number }) {
  return (
    <span
      className="flex-none inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium bg-[#8C1515] text-white"
      aria-hidden
    >
      {n}
    </span>
  );
}

function CollapsiblePanel({
  eyebrow,
  title,
  defaultOpen = false,
  testId,
  children,
}: {
  eyebrow: React.ReactNode;
  title: string;
  defaultOpen?: boolean;
  testId?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return (
    <section
      className="mb-8 border border-[#E8DDD0] rounded-xl bg-white/40"
      data-testid={testId}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={contentId}
        className="w-full flex items-center justify-between gap-4 p-5 text-left"
        data-testid={testId ? `${testId}-toggle` : undefined}
      >
        <div>
          {eyebrow}
          <h2 className="font-serif text-xl text-[#572020]">{title}</h2>
        </div>
        <span
          className={`flex-none text-[#8a6a5a] transition-transform ${
            open ? "rotate-180" : ""
          }`}
          aria-hidden
        >
          <ChevronDown />
        </span>
      </button>
      {open && (
        <div id={contentId} className="px-5 pb-6 -mt-1">
          {children}
        </div>
      )}
    </section>
  );
}

function StewardWelcomeCard({ firstName }: { firstName: string | null }) {
  // Dismissible first-run onboarding for stewards. Persists per-browser
  // via localStorage so dismissing on laptop doesn't re-show on phone
  // (intentional — we want it on every device the steward signs in on
  // until they explicitly acknowledge it there).
  const KEY = "palonur.faculty.welcomeDismissed.v1";
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      return window.localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  });
  // When dismissed, the card collapses to a quiet, always-available affordance
  // so a returning steward who got lost can always summon the explainer back —
  // re-opening in-session never clears the localStorage flag.
  const [reveal, setReveal] = useState(false);
  const [open, setOpen] = useState(false);
  const [metaTab, setMetaTab] = useState(0);
  const [openArea, setOpenArea] = useState<number>(0);
  const stepsId = useId();
  const metaBaseId = useId();

  if (dismissed && !reveal) {
    return (
      <div className="mb-8">
        <button
          type="button"
          onClick={() => {
            setReveal(true);
            setOpen(true);
          }}
          className="inline-flex items-center gap-2 rounded-full border border-[#E8DDD0] bg-white/60 px-4 py-2 text-xs font-medium text-[#8a6a5a] hover:text-[#8C1515] hover:border-[#8C1515] transition"
          data-testid="button-reopen-welcome"
        >
          <span className="text-[#8C1515]" aria-hidden>
            <IconHelp />
          </span>
          How the portal works
        </button>
      </div>
    );
  }

  const steps: Array<{
    title: string;
    icon: React.ReactNode;
    body: React.ReactNode;
  }> = [
    {
      title: "Inbox",
      icon: <IconInbox />,
      body: (
        <>
          drafts (yours or a contributor's) waiting for your sign-off. Edit them
          inline, then <em>Approve</em> to publish.
        </>
      ),
    },
    {
      title: "Library",
      icon: <IconBook />,
      body: (
        <>
          answers you've already approved. These are exactly what users see
          today when they ask a matching question on palonur.com.
        </>
      ),
    },
    {
      title: "Uncovered questions",
      icon: <IconHelp />,
      body: (
        <>
          (in the panel below) — what users asked that we couldn't answer from
          your library. Your backlog.
        </>
      ),
    },
    {
      title: "Editing a published answer",
      icon: <IconEdit />,
      body: (
        <>
          open it in Library, hit <em>Re-open</em>, edit, <em>Approve</em>{" "}
          again. The new version goes live, the old one is archived. Full
          history is kept.
        </>
      ),
    },
    {
      title: "Adding people",
      icon: <IconUsers />,
      body: (
        <>
          invite contributors or advisors from your pillar page. They can draft
          and comment; only stewards (you) approve.
        </>
      ),
    },
  ];

  const meta: Array<{
    key: string;
    tab: string;
    icon: React.ReactNode;
    heading: string;
    body: React.ReactNode;
  }> = [
    {
      key: "what",
      tab: "What this portal is",
      icon: <IconCompass />,
      heading: "A trusted answer layer, built on Stanford expertise",
      body: (
        <>
          Our portal turns the knowledge of Stanford Lifestyle Medicine faculty
          into clear, public answers people can act on. When someone asks a
          question on palonur.com, they get a real answer grounded in your
          pillar&rsquo;s library &mdash; not an anonymous guess from the open
          internet.
        </>
      ),
    },
    {
      key: "why",
      tab: "Why it exists",
      icon: <IconPulse />,
      heading: "The internet is loud. Trustworthy is rare.",
      body: (
        <>
          Online health advice is confident, endless, and unaccountable &mdash;
          no name, no source, no one who stands behind it. We flip that:
          every answer is sourced, reviewed, and owned by an expert. Fewer
          answers, but ones people can trust with their health.
        </>
      ),
    },
    {
      key: "role",
      tab: "Why you're the motor of trust",
      icon: <IconShield />,
      heading: "Nothing reaches the public until you approve it",
      body: (
        <>
          That single rule is what makes our answers trustworthy &mdash; and it runs
          on you. Your sign-off is the line between &ldquo;something on the
          internet&rdquo; and &ldquo;reviewed by a Stanford expert.&rdquo; As a{" "}
          <strong>steward</strong>, you are the engine the whole system depends
          on.
        </>
      ),
    },
  ];
  const activeMeta = meta[metaTab] ?? meta[0];

  return (
    <section
      className="mb-8 border border-[#E8DDD0] rounded-xl p-6 bg-white/60 relative"
      data-testid="card-steward-welcome"
    >
      <button
        type="button"
        onClick={() => {
          try {
            window.localStorage.setItem(KEY, "1");
          } catch {
            /* swallow private-mode storage errors */
          }
          setDismissed(true);
          setReveal(false);
        }}
        className="absolute top-4 right-4 text-[#8a6a5a] hover:text-[#572020] text-xs"
        aria-label="Dismiss"
        data-testid="button-dismiss-welcome"
      >
        Got it ×
      </button>
      <div className="flex items-start gap-4">
        <div className="flex-none hidden sm:inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-[#F9F5EE] to-[#F4ECDD] border border-[#E8DDD0]">
          <img
            src={illu("chapter-gathering")}
            alt=""
            aria-hidden
            loading="lazy"
            className="h-11 w-11 object-contain"
          />
        </div>
        <div className="min-w-0">
          <SectionEyebrow icon={<IconBook />} label="How the portal works" />
          <h2 className="font-serif text-xl mb-1 text-[#572020]">
            Welcome{firstName ? `, ${firstName}` : ""}.
          </h2>
          <p className="text-sm text-[#8a6a5a] max-w-2xl">
            You&rsquo;re a <strong>steward</strong> &mdash; the only person who
            can publish an answer in your pillar. Start here: what this is,
            why it matters, and the five places you&rsquo;ll work.
          </p>
        </div>
      </div>

      {/* Interactive meta explainer — what this is, why, and your role */}
      <div className="mt-5">
        <div
          className="flex flex-wrap gap-2"
          role="tablist"
          aria-label="About this portal"
        >
          {meta.map((m, i) => {
            const active = i === metaTab;
            return (
              <button
                key={m.key}
                type="button"
                role="tab"
                id={`${metaBaseId}-tab-${m.key}`}
                aria-selected={active}
                aria-controls={`${metaBaseId}-panel`}
                tabIndex={active ? 0 : -1}
                onClick={() => setMetaTab(i)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                    e.preventDefault();
                    const dir = e.key === "ArrowRight" ? 1 : -1;
                    const next = (i + dir + meta.length) % meta.length;
                    setMetaTab(next);
                    const el = document.getElementById(
                      `${metaBaseId}-tab-${meta[next].key}`,
                    );
                    el?.focus();
                  }
                }}
                data-testid={`tab-welcome-meta-${m.key}`}
                className={[
                  "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition",
                  active
                    ? "border-[#8C1515] bg-[#8C1515] text-white"
                    : "border-[#E8DDD0] bg-white/70 text-[#8a6a5a] hover:border-[#8C1515] hover:text-[#8C1515]",
                ].join(" ")}
              >
                <span
                  aria-hidden
                  className={active ? "text-white" : "text-[#8C1515]"}
                >
                  {m.icon}
                </span>
                {m.tab}
              </button>
            );
          })}
        </div>
        <div
          role="tabpanel"
          id={`${metaBaseId}-panel`}
          aria-labelledby={`${metaBaseId}-tab-${activeMeta.key}`}
          className="mt-3 flex items-start gap-4 rounded-xl border border-[#E8DDD0] bg-gradient-to-br from-[#F9F5EE] to-[#F4ECDD] p-4"
          data-testid="welcome-meta-panel"
        >
          <span
            className="flex-none inline-flex h-12 w-12 items-center justify-center rounded-xl border border-[#E8DDD0] bg-white text-[#8C1515] [&>svg]:h-6 [&>svg]:w-6"
            aria-hidden
          >
            {activeMeta.icon}
          </span>
          <div>
            <div className="font-serif text-base text-[#572020] mb-1">
              {activeMeta.heading}
            </div>
            <p className="text-sm text-[#8a6a5a] max-w-2xl">
              {activeMeta.body}
            </p>
          </div>
        </div>
      </div>

      {/* Interactive portal-area explorer — click an area to reveal it */}
      <div className="mt-5 border-t border-[#E8DDD0] pt-4">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={stepsId}
          className="flex w-full items-center justify-between text-left"
          data-testid="button-toggle-welcome-steps"
        >
          <span className="text-sm font-medium text-[#572020]">
            The five places you&rsquo;ll work
          </span>
          <span className="text-xs font-medium text-[#8C1515]">
            {open ? "Hide" : "Explore →"}
          </span>
        </button>
        {open && (
          <ul
            id={stepsId}
            className="mt-3 space-y-2"
            data-testid="welcome-steps"
          >
            {steps.map((s, i) => {
              const isOpen = openArea === i;
              return (
                <li
                  key={s.title}
                  className={[
                    "rounded-lg border transition",
                    isOpen
                      ? "border-[#8C1515]/40 bg-[#FBF7F0]"
                      : "border-[#E8DDD0] bg-white/60",
                  ].join(" ")}
                >
                  <button
                    type="button"
                    onClick={() => setOpenArea(isOpen ? -1 : i)}
                    aria-expanded={isOpen}
                    data-testid={`button-welcome-area-${i}`}
                    className="flex w-full items-center gap-3 p-3 text-left"
                  >
                    <span
                      className={[
                        "flex-none inline-flex h-8 w-8 items-center justify-center rounded-lg transition",
                        isOpen
                          ? "bg-[#8C1515] text-white"
                          : "bg-[#8C1515]/8 text-[#8C1515]",
                      ].join(" ")}
                      aria-hidden
                    >
                      {s.icon}
                    </span>
                    <span className="flex-1 text-sm font-medium text-[#572020]">
                      {s.title}
                    </span>
                    <span
                      className={[
                        "flex-none text-[#8a6a5a] transition-transform",
                        isOpen ? "rotate-180" : "",
                      ].join(" ")}
                      aria-hidden
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </span>
                  </button>
                  {isOpen && (
                    <div className="px-3 pb-3 pl-14 text-sm text-[#8a6a5a]">
                      {s.body}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function EmbedSnippetCard({
  slug,
  pillarName,
}: {
  slug: string;
  pillarName: string;
}) {
  // Canonical public origin for the embed page. The faculty subdomain
  // (faculty.palonur.com) is NOT the embed host — that's the consumer
  // site (palonur.com / palonur.replit.app). Resolution order:
  //   1. Vite-injected VITE_PUBLIC_WEB_ORIGIN at build time
  //   2. derive from current host: faculty.X → X (drop "faculty." prefix)
  //   3. fall back to https://palonur.com
  const ORIGIN = (() => {
    const fromEnv = (
      import.meta.env.VITE_PUBLIC_WEB_ORIGIN as string | undefined
    )?.replace(/\/$/, "");
    if (fromEnv) return fromEnv;
    if (typeof window !== "undefined") {
      const h = window.location.hostname;
      if (h.startsWith("faculty.")) {
        return `${window.location.protocol}//${h.slice("faculty.".length)}`;
      }
    }
    return "https://palonur.com";
  })();
  const embedUrl = `${ORIGIN}/embed?pillar=${encodeURIComponent(slug)}`;
  const iframeSnippet =
    `<iframe src="${embedUrl}" ` +
    `width="100%" height="640" frameborder="0" ` +
    `style="border:1px solid #E8DDD0;border-radius:12px;max-width:720px" ` +
    `title="Stanford · ${pillarName}"></iframe>`;
  const scriptSnippet =
    `<div id="palonur-embed"></div>\n` +
    `<script>\n` +
    `  (function(){\n` +
    `    var f=document.createElement('iframe');\n` +
    `    f.src='${embedUrl}';\n` +
    `    f.width='100%';f.height='640';f.frameBorder='0';\n` +
    `    f.style='border:1px solid #E8DDD0;border-radius:12px;max-width:720px';\n` +
    `    f.title='Palonur · ${pillarName}';\n` +
    `    document.getElementById('palonur-embed').appendChild(f);\n` +
    `  })();\n` +
    `</script>`;
  const [copied, setCopied] = useState<"iframe" | "script" | null>(null);
  const [showScript, setShowScript] = useState(false);
  const copy = async (text: string, kind: "iframe" | "script") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <section
      className="border border-[#E8DDD0] rounded-xl p-6 mb-8"
      data-testid="card-embed-snippet"
    >
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="font-serif text-lg">Embed on your site</h2>
        <a
          href={embedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-[#8C1515] hover:underline"
          data-testid="link-embed-preview"
        >
          Preview ↗
        </a>
      </div>
      <p className="text-sm text-[#8a6a5a] mb-4 max-w-2xl">
        Drop this snippet on your personal site, course page, or newsletter.
        Visitors get a live, Stanford-grounded answer surface showing your
        approved interpretations — your branding wraps it.
      </p>
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs uppercase tracking-[0.2em] text-[#8a6a5a]">
            HTML iframe
          </span>
          <button
            type="button"
            onClick={() => copy(iframeSnippet, "iframe")}
            className="text-xs text-[#8C1515] hover:underline"
            data-testid="button-copy-iframe"
          >
            {copied === "iframe" ? "Copied ✓" : "Copy"}
          </button>
        </div>
        <pre className="bg-[#FBF7F0] border border-[#E8DDD0] rounded-lg p-3 text-xs text-[#572020] overflow-x-auto whitespace-pre-wrap break-all">
          {iframeSnippet}
        </pre>
      </div>
      <button
        type="button"
        onClick={() => setShowScript((v) => !v)}
        className="text-xs text-[#8C1515] hover:underline mb-2"
        data-testid="button-toggle-script"
      >
        {showScript ? "Hide" : "Show"} JavaScript version
      </button>
      {showScript && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs uppercase tracking-[0.2em] text-[#8a6a5a]">
              JavaScript snippet (drop-in)
            </span>
            <button
              type="button"
              onClick={() => copy(scriptSnippet, "script")}
              className="text-xs text-[#8C1515] hover:underline"
              data-testid="button-copy-script"
            >
              {copied === "script" ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <pre className="bg-[#FBF7F0] border border-[#E8DDD0] rounded-lg p-3 text-xs text-[#572020] overflow-x-auto whitespace-pre">
            {scriptSnippet}
          </pre>
        </div>
      )}
    </section>
  );
}

function LiveAgentSnippetCard({
  slug,
  pillarName,
  expertName,
}: {
  slug: string;
  pillarName: string;
  expertName: string | null;
}) {
  // Same origin resolution as the curated EmbedSnippetCard: the live agent
  // page is served by the consumer site, not the faculty subdomain.
  const ORIGIN = (() => {
    const fromEnv = (
      import.meta.env.VITE_PUBLIC_WEB_ORIGIN as string | undefined
    )?.replace(/\/$/, "");
    if (fromEnv) return fromEnv;
    if (typeof window !== "undefined") {
      const h = window.location.hostname;
      if (h.startsWith("faculty.")) {
        return `${window.location.protocol}//${h.slice("faculty.".length)}`;
      }
    }
    return "https://palonur.com";
  })();

  const [color, setColor] = useState("#1f2937");
  const [bg, setBg] = useState("#ffffff");
  const [logo, setLogo] = useState("");
  const [name, setName] = useState(expertName ?? "");
  const [copied, setCopied] = useState<"script" | "iframe" | null>(null);

  const qs = (() => {
    const p = new URLSearchParams();
    p.set("pillar", slug);
    if (color) p.set("color", color);
    if (bg) p.set("bg", bg);
    if (logo.trim()) p.set("logo", logo.trim());
    if (name.trim()) p.set("name", name.trim());
    return p.toString();
  })();

  const iframeUrl = `${ORIGIN}/embed-agent?${qs}`;

  const scriptSnippet =
    `<script src="${ORIGIN}/embed-agent.js"\n` +
    `        data-pillar="${slug}"\n` +
    (color ? `        data-color="${color}"\n` : "") +
    (bg ? `        data-bg="${bg}"\n` : "") +
    (logo.trim() ? `        data-logo="${logo.trim()}"\n` : "") +
    (name.trim() ? `        data-name="${name.trim()}"\n` : "") +
    `        data-height="560"></script>`;

  const iframeSnippet =
    `<iframe src="${iframeUrl}" ` +
    `width="100%" height="560" frameborder="0" ` +
    `style="border:0;border-radius:14px;max-width:680px" ` +
    `title="Ask ${name.trim() || pillarName}"></iframe>`;

  const copy = async (text: string, kind: "script" | "iframe") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const labelCls =
    "text-xs uppercase tracking-[0.2em] text-[#8a6a5a] mb-1 block";
  const inputCls =
    "bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm text-[#572020] w-full";

  return (
    <section
      className="border border-[#E8DDD0] rounded-xl p-6 mb-8"
      data-testid="card-live-agent-snippet"
    >
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="font-serif text-lg">Live "ask anything" agent</h2>
        <a
          href={iframeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-[#8C1515] hover:underline"
          data-testid="link-live-agent-preview"
        >
          Preview ↗
        </a>
      </div>
      <p className="text-sm text-[#8a6a5a] mb-4 max-w-2xl">
        A streaming, white-label agent that answers visitors&apos; questions
        using <strong>only your pillar&apos;s</strong> approved sources and
        interpretations — no other pillars, no generic corpus. Style it to your
        brand, then paste one line on your site.
      </p>

      <div className="grid grid-cols-2 gap-3 mb-4 max-w-lg">
        <label className="block">
          <span className={labelCls}>Primary color</span>
          <input
            type="text"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            placeholder="#1f2937"
            className={inputCls}
            data-testid="input-agent-color"
          />
        </label>
        <label className="block">
          <span className={labelCls}>Background</span>
          <input
            type="text"
            value={bg}
            onChange={(e) => setBg(e.target.value)}
            placeholder="#ffffff"
            className={inputCls}
            data-testid="input-agent-bg"
          />
        </label>
        <label className="block">
          <span className={labelCls}>Display name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={expertName ?? "Your name"}
            className={inputCls}
            data-testid="input-agent-name"
          />
        </label>
        <label className="block">
          <span className={labelCls}>Logo URL</span>
          <input
            type="text"
            value={logo}
            onChange={(e) => setLogo(e.target.value)}
            placeholder="https://…/logo.png"
            className={inputCls}
            data-testid="input-agent-logo"
          />
        </label>
      </div>

      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs uppercase tracking-[0.2em] text-[#8a6a5a]">
            One-line script (recommended)
          </span>
          <button
            type="button"
            onClick={() => copy(scriptSnippet, "script")}
            className="text-xs text-[#8C1515] hover:underline"
            data-testid="button-copy-agent-script"
          >
            {copied === "script" ? "Copied ✓" : "Copy"}
          </button>
        </div>
        <pre className="bg-[#FBF7F0] border border-[#E8DDD0] rounded-lg p-3 text-xs text-[#572020] overflow-x-auto whitespace-pre">
          {scriptSnippet}
        </pre>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs uppercase tracking-[0.2em] text-[#8a6a5a]">
            Raw iframe (fallback)
          </span>
          <button
            type="button"
            onClick={() => copy(iframeSnippet, "iframe")}
            className="text-xs text-[#8C1515] hover:underline"
            data-testid="button-copy-agent-iframe"
          >
            {copied === "iframe" ? "Copied ✓" : "Copy"}
          </button>
        </div>
        <pre className="bg-[#FBF7F0] border border-[#E8DDD0] rounded-lg p-3 text-xs text-[#572020] overflow-x-auto whitespace-pre-wrap break-all">
          {iframeSnippet}
        </pre>
      </div>
    </section>
  );
}

function WhyJoinPanel({ role }: { role?: NonStewardRole }) {
  // Role-aware, always-visible value-prop card. Persistent — unlike the
  // dismissible Welcome card, faculty may want to revisit these trust signals.
  //
  // Stewards (role undefined) see the full set, including the steward-only
  // claims: data ownership/sign-off and the embed snippet. Contributors and
  // advisors see only what genuinely applies to them (privacy of the raw
  // material they add, seeing themselves in external AI, revenue share on
  // interpretations they draft). Viewers — who don't add sources or draft —
  // see only the platform-level privacy + transparency tiles, never the
  // overpromising author/owner claims.
  type Benefit = {
    title: string;
    body: string;
    icon: React.ReactNode;
    soon?: boolean;
  };

  const ownData: Benefit = {
    title: "You own the data — always",
    icon: <IconLock />,
    body: "Every source, interpretation, and edit lives under your pillar. You can export, revise, or remove anything at any time. Nothing is shared without your sign-off.",
  };
  const embeddable: Benefit = {
    title: "Embeddable anywhere",
    icon: <IconCode />,
    body: "Drop your answer surface into your own site, course page, or newsletter via a third-party UI. Same content, your branding.",
  };
  const rawMaterialSteward: Benefit = {
    title: "AI never sees the raw material",
    icon: <IconShield />,
    body: "Models retrieve from chunked, embedded passages — never your full PDFs or notes. Your books, drafts, and unpublished work stay behind the wall.",
  };
  const externalAiSteward: Benefit = {
    title: "See yourself in external AI",
    icon: <IconPulse />,
    body: "Track how your published answers show up — or get paraphrased — in ChatGPT, Perplexity, and Claude. Spot misattribution before it spreads.",
  };
  const revenueSteward: Benefit = {
    title: "Earn from your work",
    icon: <IconCoin />,
    body: "Revenue share on paid queries that retrieve your interpretations. Coming soon.",
    soon: true,
  };

  // Contributor / advisor — they add sources and draft answers, so the privacy,
  // external-AI, and revenue-share benefits apply, but worded for their role
  // (no ownership/sign-off, no embed snippet).
  const rawMaterialAuthor: Benefit = {
    title: "AI never sees your raw material",
    icon: <IconShield />,
    body: "Models retrieve from chunked, embedded passages — never your full PDFs or notes. The papers, drafts, and notes you add stay behind the wall.",
  };
  const externalAiAuthor: Benefit = {
    title: "See yourself in external AI",
    icon: <IconPulse />,
    body: "Track how the answers you help draft show up — or get paraphrased — in ChatGPT, Perplexity, and Claude. Spot misattribution before it spreads.",
  };
  const revenueAuthor: Benefit = {
    title: "Earn from your work",
    icon: <IconCoin />,
    body: "Revenue share on paid queries that retrieve interpretations you drafted. Coming soon.",
    soon: true,
  };

  // Viewer — read-only, so only platform-level privacy + transparency apply.
  const rawMaterialViewer: Benefit = {
    title: "AI never sees the raw material",
    icon: <IconShield />,
    body: "Models retrieve from chunked, embedded passages — never full PDFs or notes. The faculty work behind every answer stays behind the wall.",
  };
  const seeWhatReadersSee: Benefit = {
    title: "See exactly what readers see",
    icon: <IconBook />,
    body: "Follow every answer Stanford stewards publish — the same cited, trusted content that appears on palonur.com.",
  };

  let benefits: Benefit[];
  if (!role) {
    benefits = [
      ownData,
      rawMaterialSteward,
      externalAiSteward,
      embeddable,
      revenueSteward,
    ];
  } else if (role === "viewer") {
    benefits = [rawMaterialViewer, seeWhatReadersSee];
  } else {
    benefits = [rawMaterialAuthor, externalAiAuthor, revenueAuthor];
  }
  return (
    <CollapsiblePanel
      testId="card-why-palonur"
      eyebrow={
        <SectionEyebrow
          icon={<IconShield />}
          label="Why Join · faculty benefits"
        />
      }
      title="Why Join, for you"
    >
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {benefits.map((b) => (
          <div
            key={b.title}
            className={`border border-[#E8DDD0] rounded-lg p-4 ${
              b.soon ? "opacity-50 bg-[#FBF7F0]" : "bg-white/60"
            }`}
            data-testid={`tile-benefit-${b.title
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/(^-|-$)/g, "")}`}
          >
            <div className="flex items-start gap-2.5 mb-1.5">
              <span
                className="flex-none inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[#8C1515]/8 text-[#8C1515]"
                aria-hidden
              >
                {b.icon}
              </span>
              <div className="flex-1 flex items-baseline justify-between gap-2">
                <h3 className="font-medium text-sm text-[#572020]">
                  {b.title}
                </h3>
                {b.soon && (
                  <span className="text-[9px] tracking-[0.2em] text-[#8a6a5a] uppercase">
                    Soon
                  </span>
                )}
              </div>
            </div>
            <p className="text-xs text-[#8a6a5a] leading-relaxed">{b.body}</p>
          </div>
        ))}
      </div>
    </CollapsiblePanel>
  );
}

// ---------- Admin: stewards roster + dashboard preview ----------

/**
 * One-click lift of a temporary Clerk sign-in lockout (too many failed
 * password attempts). Only rendered when the roster reports
 * `clerkStatus === "locked"`; on success the roster is refetched so the
 * badge clears immediately.
 */
function UnlockMemberButton({ member }: { member: { id: number } }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const unlock = useMutation({
    mutationFn: () =>
      fetchJson(`/api/faculty/admin/members/${member.id}/unlock`, {
        method: "POST",
      }),
    onSuccess: () => {
      setErr(null);
      void qc.invalidateQueries({ queryKey: ["faculty-admin-members"] });
    },
    onError: (e) => setErr((e as Error).message),
  });
  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={unlock.isPending}
        onClick={() => unlock.mutate()}
        className="border border-amber-500 text-amber-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-50 transition disabled:opacity-40"
        title="Lift the temporary sign-in lockout so this member can sign in again right away."
        data-testid={`button-unlock-${member.id}`}
      >
        {unlock.isPending ? "Unlocking…" : "Unlock sign-in"}
      </button>
      {err && (
        <span
          className="text-xs text-[#E8352A] max-w-[16rem] text-right"
          data-testid={`text-unlock-error-${member.id}`}
        >
          {err}
        </span>
      )}
    </span>
  );
}

interface AdminMember {
  id: number;
  fullName: string | null;
  email: string;
  institution: string | null;
  photoUrl: string | null;
  isPlatformAdmin: boolean;
  registered: boolean;
  onboardedAt: string | null;
  deactivatedAt: string | null;
  archivedAt: string | null;
  clerkStatus: "active" | "banned" | "locked" | "unknown";
  clerkMismatch: boolean;
  memberships: Array<{
    pillarId: number;
    pillarSlug: string;
    pillarName: string;
    role: string;
    /** True when custodian@palonur.com is co-steward on this pillar. */
    isCustodianHeld?: boolean;
  }>;
}

interface AdminPillar {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  retiredAt: string | null;
  facultyCount: number;
  sourceCount: number;
  interpretationCount: number;
  pendingInviteCount: number;
  /**
   * Human-readable routing terms from the public question router. Empty
   * for pillars with no keyword entry — those are reached only when no
   * keyword matches anywhere and the router fans out to all pillars.
   */
  routingKeywords?: string[];
}

interface AdminChannelInterest {
  channelKey: string;
  count: number;
  members: Array<{
    userId: number;
    fullName: string | null;
    email: string;
    createdAt: string;
  }>;
}

// A DB-backed Distribution Channels card. `outlet` opens a bespoke in-page
// detail view (the views themselves live in code); `href` links out; a "soon"
// card with neither shows the notify-me control keyed by `key`. `key` is
// immutable once created (it anchors faculty_channel_interest rows).
interface DistributionChannel {
  id: number;
  key: string;
  name: string;
  description: string;
  category: string;
  status: "live" | "soon";
  href: string | null;
  outlet: "newsletter" | "matt" | "parentdata" | null;
  isPrimary: boolean;
  sortOrder: number;
}

// Human-readable labels for the "soon" channel keys persisted from the faculty
// distribution-channels showcase. Falls back to the raw key for any unmapped
// channel.
const CHANNEL_KEY_LABELS: Record<string, string> = {
  "think-fast-talk-smart": "Think Fast, Talk Smart",
  "stanford-medcast": "Stanford Medcast",
  "new-york-times": "The New York Times",
  "washington-post": "The Washington Post",
  time: "TIME",
  "the-atlantic": "The Atlantic",
};

const memberRoleStyle: Record<string, string> = {
  steward: "bg-[#8C1515] text-white",
  contributor: "bg-[#F3E9D8] text-[#8a6a5a]",
  advisor: "bg-[#E6ECF6] text-[#2a4d8f]",
  viewer: "bg-[#EEE7DC] text-[#8a6a5a]",
};

function ViewAsBanner() {
  const viewAs = useViewAs();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  if (!viewAs) return null;
  return (
    <div
      className="sticky top-0 z-[100] bg-[#8C1515] text-white text-sm px-6 py-2 flex items-center justify-between"
      data-testid="banner-viewas"
    >
      <span>
        Previewing as <strong>{viewAs.name}</strong> · read-only — this is
        exactly what they see in their portal.
      </span>
      <button
        className="underline hover:no-underline font-medium"
        data-testid="button-exit-preview"
        onClick={() => {
          setViewAs(null);
          qc.invalidateQueries();
          setLocation("/admin");
        }}
      >
        Exit preview
      </button>
    </div>
  );
}

// A steward's lifecycle stage, derived from registration + onboarding:
//  - "invited"   — still a `pending:` placeholder; never signed in
//  - "user"      — activated/registered (real account) but hasn't finished
//                  the one-time welcome story yet
//  - "onboarded" — registered AND completed the welcome story
type MemberStatus = "invited" | "user" | "onboarded";

function memberStatus(m: AdminMember): MemberStatus {
  if (m.onboardedAt != null) return "onboarded";
  return m.registered ? "user" : "invited";
}

const MEMBER_STATUS_LABEL: Record<MemberStatus, string> = {
  invited: "Invited",
  user: "User",
  onboarded: "Onboarded",
};

type RosterFilter =
  | { kind: "status"; status: MemberStatus }
  | { kind: "admin" }
  | { kind: "deactivated" }
  | { kind: "pillar"; pillarId: number; pillarName: string }
  | { kind: "role"; pillarId: number; role: string; pillarName: string };

function rosterFilterLabel(f: RosterFilter): string {
  if (f.kind === "status") return MEMBER_STATUS_LABEL[f.status];
  if (f.kind === "admin") return "Platform admins";
  if (f.kind === "deactivated") return "Removed";
  if (f.kind === "pillar") return f.pillarName;
  return `${f.pillarName} · ${f.role}`;
}

function rosterFilterEq(a: RosterFilter, b: RosterFilter): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "status" && b.kind === "status") return a.status === b.status;
  if (a.kind === "admin") return true;
  if (a.kind === "deactivated") return true;
  if (a.kind === "pillar" && b.kind === "pillar")
    return a.pillarId === b.pillarId;
  if (a.kind === "role" && b.kind === "role")
    return a.pillarId === b.pillarId && a.role === b.role;
  return false;
}

function memberMatchesFilter(m: AdminMember, f: RosterFilter): boolean {
  if (f.kind === "status") return memberStatus(m) === f.status;
  if (f.kind === "admin") return m.isPlatformAdmin;
  if (f.kind === "deactivated") return m.deactivatedAt != null;
  if (f.kind === "pillar")
    return m.memberships.some((mm) => mm.pillarId === f.pillarId);
  return m.memberships.some(
    (mm) => mm.pillarId === f.pillarId && mm.role === f.role,
  );
}

interface AdminApplication {
  id: number;
  status: "applied" | "under_review" | "admitted" | "declined";
  institution: string;
  field: string;
  workUrl: string | null;
  institutionalEmail: string;
  institutionalEmailVerified: boolean;
  declineNote: string | null;
  createdAt: string;
  decidedAt: string | null;
  applicantName: string | null;
  applicantEmail: string;
  userId: number;
}

interface InstitutionAgreement {
  id: number;
  institution: string;
  agreementActive: boolean;
  note: string | null;
  updatedAt: string;
}

// Admin-only admission review queue plus the institution-level agreement flag
// (a business fact that never appears in any professor-facing flow).
function AdminAdmissions() {
  const { data: me, isLoading: meLoading } = useMe();
  const qc = useQueryClient();
  const [decidingId, setDecidingId] = useState<number | null>(null);
  const [admitPillarId, setAdmitPillarId] = useState<number | "">("");
  const [admitRole, setAdmitRole] = useState<
    "steward" | "contributor" | "advisor" | "viewer"
  >("steward");
  const [declineNote, setDeclineNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [agInstitution, setAgInstitution] = useState("");
  const [agActive, setAgActive] = useState(false);
  const [agNote, setAgNote] = useState("");

  const appsQuery = useQuery<{ applications: AdminApplication[] }>({
    queryKey: ["faculty-admin-applications"],
    queryFn: () => fetchJson("/api/faculty/admin/applications"),
    enabled: !!me && me.user.isPlatformAdmin,
  });
  const pillarsQuery = useQuery<{ pillars: AdminPillar[] }>({
    queryKey: ["faculty-admin-pillars"],
    queryFn: () => fetchJson("/api/faculty/admin/pillars"),
    enabled: !!me && me.user.isPlatformAdmin,
  });
  const agreementsQuery = useQuery<{ agreements: InstitutionAgreement[] }>({
    queryKey: ["faculty-admin-institution-agreements"],
    queryFn: () => fetchJson("/api/faculty/admin/institution-agreements"),
    enabled: !!me && me.user.isPlatformAdmin,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["faculty-admin-applications"] });
    qc.invalidateQueries({ queryKey: ["faculty-admin-members"] });
  };
  const review = useMutation({
    mutationFn: (id: number) =>
      fetchJson(`/api/faculty/admin/applications/${id}/review`, {
        method: "POST",
      }),
    onSuccess: refresh,
    onError: (e) => setMsg((e as Error).message),
  });
  const admit = useMutation({
    mutationFn: (vars: { id: number; pillarId: number; role: string }) =>
      fetchJson(`/api/faculty/admin/applications/${vars.id}/admit`, {
        method: "POST",
        body: JSON.stringify({ pillarId: vars.pillarId, role: vars.role }),
      }),
    onSuccess: () => {
      setDecidingId(null);
      setMsg("Admitted. A warm welcome email is on its way.");
      refresh();
    },
    onError: (e) => setMsg((e as Error).message),
  });
  const decline = useMutation({
    mutationFn: (vars: { id: number; note?: string }) =>
      fetchJson(`/api/faculty/admin/applications/${vars.id}/decline`, {
        method: "POST",
        body: JSON.stringify({ note: vars.note || undefined }),
      }),
    onSuccess: () => {
      setDecidingId(null);
      setDeclineNote("");
      setMsg("Declined. The applicant was emailed honestly and warmly.");
      refresh();
    },
    onError: (e) => setMsg((e as Error).message),
  });
  const saveAgreement = useMutation({
    mutationFn: (vars: {
      institution: string;
      agreementActive: boolean;
      note?: string;
    }) =>
      fetchJson("/api/faculty/admin/institution-agreements", {
        method: "PUT",
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      setAgInstitution("");
      setAgNote("");
      setAgActive(false);
      qc.invalidateQueries({
        queryKey: ["faculty-admin-institution-agreements"],
      });
    },
    onError: (e) => setMsg((e as Error).message),
  });

  if (meLoading)
    return (
      <PortalShell>
        <p className="text-[#8a6a5a]">Loading…</p>
      </PortalShell>
    );
  if (me && !me.user.isPlatformAdmin) return <Redirect to="/dashboard" />;

  const apps = appsQuery.data?.applications ?? [];
  const pending = apps.filter(
    (a) => a.status === "applied" || a.status === "under_review",
  );
  const decided = apps.filter(
    (a) => a.status === "admitted" || a.status === "declined",
  );
  const pillars = pillarsQuery.data?.pillars ?? [];

  const card = (a: AdminApplication) => (
    <div
      key={a.id}
      className="rounded-xl border border-[#E8DDD0] bg-white/60 p-5"
      data-testid={`card-application-${a.id}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <div>
          <span className="font-medium">
            {a.applicantName ?? a.applicantEmail}
          </span>{" "}
          <span className="text-sm text-[#8a6a5a]">· {a.institution}</span>
        </div>
        <span
          className="text-xs uppercase tracking-wide text-[#8C1515]"
          data-testid={`text-status-${a.id}`}
        >
          {a.status.replace("_", " ")}
        </span>
      </div>
      <p className="text-sm text-[#572020] mb-1">Field: {a.field}</p>
      <p className="text-sm text-[#8a6a5a] mb-1">
        Sign-in email: {a.applicantEmail}
      </p>
      <p className="text-sm text-[#8a6a5a] mb-1">
        University email: {a.institutionalEmail}{" "}
        {a.institutionalEmailVerified ? (
          <span className="text-green-700">confirmed</span>
        ) : (
          <span className="text-[#E8352A]">not confirmed</span>
        )}
      </p>
      {a.workUrl && (
        <p className="text-sm mb-1 break-all">
          <a
            href={a.workUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[#8C1515] underline hover:no-underline"
          >
            {a.workUrl}
          </a>
        </p>
      )}
      {a.declineNote && (
        <p className="text-sm text-[#8a6a5a] mt-1">Note: {a.declineNote}</p>
      )}
      {(a.status === "applied" || a.status === "under_review") && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {a.status === "applied" && (
            <button
              onClick={() => review.mutate(a.id)}
              className="text-sm text-[#8a6a5a] underline hover:no-underline"
              data-testid={`button-review-${a.id}`}
            >
              Mark under review
            </button>
          )}
          <button
            onClick={() => {
              setDecidingId(decidingId === a.id ? null : a.id);
              setAdmitPillarId("");
              setAdmitRole("steward");
              setDeclineNote("");
            }}
            className="text-sm bg-[#8C1515] text-white px-4 py-1.5 rounded-lg hover:bg-[#a01a1a] transition"
            data-testid={`button-decide-${a.id}`}
          >
            Decide
          </button>
        </div>
      )}
      {decidingId === a.id && (
        <div className="mt-4 rounded-lg bg-[#F7F0E4] p-4 space-y-3">
          <div className="flex flex-wrap gap-3">
            <select
              value={admitPillarId}
              onChange={(e) =>
                setAdmitPillarId(e.target.value ? Number(e.target.value) : "")
              }
              className="rounded-lg border border-[#E8DDD0] bg-white px-3 py-2 text-sm"
              data-testid={`select-admit-pillar-${a.id}`}
            >
              <option value="">Choose a pillar…</option>
              {pillars.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              value={admitRole}
              onChange={(e) => setAdmitRole(e.target.value as typeof admitRole)}
              className="rounded-lg border border-[#E8DDD0] bg-white px-3 py-2 text-sm"
              data-testid={`select-admit-role-${a.id}`}
            >
              <option value="steward">Steward</option>
              <option value="contributor">Contributor</option>
              <option value="advisor">Advisor</option>
              <option value="viewer">Viewer</option>
            </select>
            <button
              disabled={!admitPillarId || admit.isPending}
              onClick={() =>
                admitPillarId &&
                admit.mutate({
                  id: a.id,
                  pillarId: admitPillarId,
                  role: admitRole,
                })
              }
              className="text-sm bg-[#8C1515] text-white px-4 py-2 rounded-lg hover:bg-[#a01a1a] transition disabled:opacity-40"
              data-testid={`button-admit-${a.id}`}
            >
              Admit
            </button>
          </div>
          <div className="flex flex-wrap gap-3 items-start">
            <textarea
              value={declineNote}
              onChange={(e) => setDeclineNote(e.target.value)}
              placeholder="Optional note to the applicant"
              rows={2}
              className="flex-1 min-w-[220px] rounded-lg border border-[#E8DDD0] bg-white px-3 py-2 text-sm"
              data-testid={`input-decline-note-${a.id}`}
            />
            <button
              disabled={decline.isPending}
              onClick={() => decline.mutate({ id: a.id, note: declineNote })}
              className="text-sm border border-[#8C1515] text-[#8C1515] px-4 py-2 rounded-lg hover:bg-[#8C1515]/5 transition disabled:opacity-40"
              data-testid={`button-decline-${a.id}`}
            >
              Decline
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <PortalShell>
      <p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-3">
        Admin · Admissions
      </p>
      <h1 className="font-serif text-3xl font-medium mb-2">
        Faculty applications
      </h1>
      <p className="text-[#8a6a5a] mb-6 leading-relaxed max-w-2xl">
        Every self-serve applicant lands here. Admitting creates the membership
        exactly like accepting an invitation; declining sends a warm, honest
        email. Invited and pre-seeded faculty never appear in this queue.
      </p>
      {msg && (
        <p
          className="mb-4 text-sm text-[#572020]"
          data-testid="text-admissions-msg"
        >
          {msg}
        </p>
      )}
      {appsQuery.isLoading ? (
        <p className="text-[#8a6a5a]">Loading…</p>
      ) : (
        <>
          <div
            className="space-y-4 mb-10"
            data-testid="list-pending-applications"
          >
            {pending.length === 0 && (
              <p className="text-[#8a6a5a]" data-testid="text-no-pending">
                No applications waiting. New ones appear here the moment a
                professor applies.
              </p>
            )}
            {pending.map(card)}
          </div>
          {decided.length > 0 && (
            <>
              <h2 className="font-serif text-xl font-medium mb-3">Decided</h2>
              <div className="space-y-4 mb-10">{decided.map(card)}</div>
            </>
          )}
        </>
      )}

      <h2 className="font-serif text-xl font-medium mb-2">
        Institution agreements
      </h2>
      <p className="text-[#8a6a5a] text-sm mb-4 max-w-2xl">
        A business-level fact per institution. It can later gate public-facing
        pillar behavior and is never shown to professors.
      </p>
      <div className="space-y-2 mb-4">
        {(agreementsQuery.data?.agreements ?? []).map((g) => (
          <div
            key={g.id}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-[#E8DDD0] bg-white/60 px-4 py-2 text-sm"
            data-testid={`row-agreement-${g.id}`}
          >
            <span className="font-medium">{g.institution}</span>
            <span
              className={
                g.agreementActive ? "text-green-700" : "text-[#8a6a5a]"
              }
            >
              {g.agreementActive ? "Agreement active" : "No agreement"}
            </span>
            {g.note && <span className="text-[#8a6a5a]">{g.note}</span>}
            <button
              onClick={() =>
                saveAgreement.mutate({
                  institution: g.institution,
                  agreementActive: !g.agreementActive,
                  note: g.note ?? undefined,
                })
              }
              className="ml-auto text-[#8C1515] underline hover:no-underline"
              data-testid={`button-toggle-agreement-${g.id}`}
            >
              {g.agreementActive ? "Mark inactive" : "Mark active"}
            </button>
          </div>
        ))}
      </div>
      <form
        className="flex flex-wrap gap-3 items-center"
        onSubmit={(e) => {
          e.preventDefault();
          if (!agInstitution.trim()) return;
          saveAgreement.mutate({
            institution: agInstitution.trim(),
            agreementActive: agActive,
            note: agNote.trim() || undefined,
          });
        }}
      >
        <input
          value={agInstitution}
          onChange={(e) => setAgInstitution(e.target.value)}
          placeholder="Institution name"
          className="rounded-lg border border-[#E8DDD0] bg-white px-3 py-2 text-sm"
          data-testid="input-agreement-institution"
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={agActive}
            onChange={(e) => setAgActive(e.target.checked)}
            data-testid="checkbox-agreement-active"
          />
          Agreement active
        </label>
        <input
          value={agNote}
          onChange={(e) => setAgNote(e.target.value)}
          placeholder="Note (optional)"
          className="rounded-lg border border-[#E8DDD0] bg-white px-3 py-2 text-sm"
          data-testid="input-agreement-note"
        />
        <button
          type="submit"
          disabled={saveAgreement.isPending}
          className="text-sm bg-[#8C1515] text-white px-4 py-2 rounded-lg hover:bg-[#a01a1a] transition disabled:opacity-40"
          data-testid="button-save-agreement"
        >
          Save
        </button>
      </form>
    </PortalShell>
  );
}

function AdminMembers() {
  const { data: me, isLoading: meLoading } = useMe();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const viewAs = useViewAs();
  const [editing, setEditing] = useState<AdminMember | null>(null);
  const [filter, setFilter] = useState<RosterFilter | null>(null);
  const [showDeactivated, setShowDeactivated] = useState(false);
  const [newsletterOpen, setNewsletterOpen] = useState(false);
  const [newsletterReady, setNewsletterReady] = useState(false);
  const [newsletterError, setNewsletterError] = useState<string | null>(null);
  const [creatingPillar, setCreatingPillar] = useState(false);
  const [editingPillar, setEditingPillar] = useState<AdminPillar | null>(null);
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [editingChannel, setEditingChannel] =
    useState<DistributionChannel | null>(null);
  const [inviteFor, setInviteFor] = useState<AdminPillar | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<
    "steward" | "contributor" | "advisor" | "viewer"
  >("steward");
  const [inviteInstitution, setInviteInstitution] = useState("");
  // "standard" = normal faculty flow; "aslm" = invitee arrives via
  // AskLifestyleMedicine and will see the trimmed portal.
  const [inviteChannel, setInviteChannel] = useState<"standard" | "aslm">(
    "standard",
  );
  const [inviteMsg, setInviteMsg] = useState<string | null>(null);
  const inviteMutation = useMutation({
    mutationFn: (vars: {
      email: string;
      role: string;
      pillarId: number;
      institution?: string;
      channel?: "aslm";
    }) =>
      fetchJson<{ email: string; role: string }>("/api/faculty/invitations", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: (r) => {
      setInviteMsg(`Sent invite to ${r.email} as ${r.role}.`);
      setInviteEmail("");
      setInviteInstitution("");
      qc.invalidateQueries({ queryKey: ["faculty-admin-pillars"] });
      qc.invalidateQueries({ queryKey: ["faculty-admin-members"] });
    },
    onError: (e: Error) => setInviteMsg(`Error: ${e.message}`),
  });

  function openInvite(p: AdminPillar): void {
    setInviteFor(p);
    setInviteEmail("");
    setInviteRole("steward");
    setInviteInstitution("");
    setInviteChannel("standard");
    setInviteMsg(null);
    inviteMutation.reset();
  }

  function closeInvite(): void {
    setInviteFor(null);
    setInviteMsg(null);
    inviteMutation.reset();
  }
  const membersQuery = useQuery<{ members: AdminMember[] }>({
    queryKey: ["faculty-admin-members"],
    queryFn: () => fetchJson("/api/faculty/admin/members"),
    enabled: !!me && me.user.isPlatformAdmin,
  });
  const pillarsQuery = useQuery<{ pillars: AdminPillar[] }>({
    queryKey: ["faculty-admin-pillars"],
    queryFn: () => fetchJson("/api/faculty/admin/pillars"),
    enabled: !!me && me.user.isPlatformAdmin,
  });
  const channelInterestQuery = useQuery<{ channels: AdminChannelInterest[] }>({
    queryKey: ["faculty-admin-channel-interest"],
    queryFn: () => fetchJson("/api/faculty/admin/channel-interest"),
    enabled: !!me && me.user.isPlatformAdmin,
  });
  const adminChannelsQuery = useQuery<{ channels: DistributionChannel[] }>({
    queryKey: ["faculty-admin-distribution-channels"],
    queryFn: () => fetchJson("/api/faculty/admin/distribution-channels"),
    enabled: !!me && me.user.isPlatformAdmin,
  });

  if (meLoading)
    return (
      <PortalShell>
        <p className="text-[#8a6a5a]">Loading…</p>
      </PortalShell>
    );
  if (me && !me.user.isPlatformAdmin) return <Redirect to="/dashboard" />;

  const members = membersQuery.data?.members ?? [];
  const deactivatedCount = members.filter(
    (m) => m.deactivatedAt != null,
  ).length;
  const isolatingDeactivated = filter?.kind === "deactivated";
  const visibleMembers = members.filter((m) => {
    if (filter && !memberMatchesFilter(m, filter)) return false;
    if (m.deactivatedAt != null && !showDeactivated && !isolatingDeactivated)
      return false;
    return true;
  });

  function toggleFilter(f: RosterFilter): void {
    setFilter((cur) => (cur && rosterFilterEq(cur, f) ? null : f));
  }

  async function openNewsletter(): Promise<void> {
    setNewsletterError(null);
    setNewsletterReady(false);
    setNewsletterOpen(true);
    try {
      await fetchJson("/api/faculty/admin/newsletter-session", {
        method: "POST",
      });
      setNewsletterReady(true);
    } catch (e) {
      setNewsletterError((e as Error).message);
    }
  }

  function preview(m: AdminMember): void {
    setViewAs({ id: m.id, name: m.fullName ?? m.email });
    qc.invalidateQueries();
    setLocation("/dashboard");
  }

  return (
    <PortalShell>
      <p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-3">
        Admin · Stewards
      </p>
      <h1 className="font-serif text-3xl font-medium mb-2">Faculty roster</h1>
      <p className="text-[#8a6a5a] mb-2 leading-relaxed max-w-2xl">
        Every faculty member, the pillars they hold, and where they are in
        onboarding. The first-login welcome story is{" "}
        <strong>identical for everyone</strong> — what differs is the portal
        each person sees once inside, shaped entirely by their pillars and
        roles.
      </p>
      <p className="text-[#8a6a5a] mb-8 text-sm">
        Use “Preview dashboard” to open any member’s portal as they see it
        (read-only). This always shows their actual dashboard, even for members
        who haven’t onboarded yet — the welcome story is identical for everyone
        and only appears on a member’s real first login.
      </p>

      <section className="mb-10" data-testid="admin-pillars-section">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="font-serif text-2xl font-medium">Pillars</h2>
          <button
            type="button"
            onClick={() => setCreatingPillar(true)}
            className="bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition shrink-0"
            data-testid="button-new-pillar"
          >
            + New pillar
          </button>
        </div>
        <p className="text-[#8a6a5a] mb-4 text-sm max-w-2xl">
          Every coverage area the platform offers, with how much content each
          holds. Pillars with <strong>no faculty yet</strong> are still listed
          so you can plan coverage and invite stewards. Select a pillar to
          filter the roster below, or use the actions to rename, retire, or
          remove one.
        </p>
        <div
          className="border border-[#E8DDD0] bg-[#F9F5EE] rounded-xl p-4 mb-4 max-w-3xl"
          data-testid="routing-explainer"
        >
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[#8C1515] mb-1.5">
            How reader questions reach a pillar
          </p>
          <p className="text-xs text-[#8a6a5a] leading-relaxed">
            The public agent routes each question by the terms shown on the
            cards below. When a question matches <strong>one</strong> pillar,
            only that steward&apos;s approved corpus answers. When it matches{" "}
            <strong>two or more</strong> (say, an Alzheimer&apos;s-caregiver
            question about sleep), all matched corpora are searched, the
            strongest match writes the signed answer, and any other matched
            pillar with approved material on the question appears as a
            &ldquo;another perspective&rdquo; pointer under the answer — the
            answer itself is never blended across stewards. Questions matching{" "}
            <strong>no</strong> terms are searched across every active pillar.
            Pillars without routing terms are reached only through that
            fallback.
          </p>
        </div>
        {pillarsQuery.isLoading && (
          <p className="text-[#8a6a5a] text-sm">Loading pillars…</p>
        )}
        {pillarsQuery.error && (
          <p
            className="text-[#E8352A] text-sm"
            data-testid="text-pillars-error"
          >
            {(pillarsQuery.error as Error).message}
          </p>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {(pillarsQuery.data?.pillars ?? []).map((p) => {
            const active =
              filter?.kind === "pillar" && filter.pillarId === p.id;
            const empty = p.facultyCount === 0;
            const retired = p.retiredAt != null;
            return (
              <div
                key={p.id}
                className={`text-left border rounded-xl p-4 transition flex flex-col ${
                  retired
                    ? "border-[#E8DDD0] bg-[#F4EEE6] opacity-80"
                    : active
                      ? "border-[#8C1515] bg-[#F9F0EE]"
                      : "border-[#E8DDD0] hover:border-[#8C1515]"
                }`}
                data-testid={`card-pillar-${p.id}`}
              >
                <button
                  type="button"
                  onClick={() =>
                    toggleFilter({
                      kind: "pillar",
                      pillarId: p.id,
                      pillarName: p.name,
                    })
                  }
                  className="text-left"
                  title={`Filter the roster by ${p.name}`}
                  data-testid={`filter-pillar-${p.id}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 min-w-0">
                      <img
                        src={pillarIllu(p.slug)}
                        alt=""
                        aria-hidden
                        className="flex-none h-8 w-8 object-contain"
                      />
                      <span className="font-serif text-lg text-[#572020] truncate">
                        {p.name}
                      </span>
                    </span>
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded-full ${
                          empty
                            ? "bg-[#F3E0DE] text-[#8C1515]"
                            : "bg-[#E3F0E3] text-[#2f6b3a]"
                        }`}
                        data-testid={`pillar-count-${p.id}`}
                      >
                        {p.facultyCount}{" "}
                        {p.facultyCount === 1 ? "steward" : "faculty"}
                      </span>
                      {p.pendingInviteCount > 0 && (
                        <span
                          className="text-[11px] px-2 py-0.5 rounded-full bg-[#FBEFD8] text-[#8a6a3a]"
                          data-testid={`pillar-pending-${p.id}`}
                        >
                          {p.pendingInviteCount} pending
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="text-[11px] text-[#a08c7c] font-mono mt-0.5">
                    {p.slug}
                    {retired && (
                      <span
                        className="ml-2 not-italic font-sans bg-[#EADFD2] text-[#8a6a5a] px-1.5 py-0.5 rounded uppercase tracking-wide text-[9px]"
                        data-testid={`pillar-retired-${p.id}`}
                      >
                        Retired
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-[#8a6a5a] mt-1">
                    {p.sourceCount} source{p.sourceCount === 1 ? "" : "s"} ·{" "}
                    {p.interpretationCount} interpretation
                    {p.interpretationCount === 1 ? "" : "s"}
                  </p>
                  {(p.routingKeywords?.length ?? 0) > 0 ? (
                    <p
                      className="mt-2 flex flex-wrap gap-1"
                      data-testid={`pillar-keywords-${p.id}`}
                    >
                      {(p.routingKeywords ?? []).map((kw) => (
                        <span
                          key={kw}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-[#F4ECDD] text-[#6b5a3a] border border-[#E8DDC8]"
                        >
                          {kw}
                        </span>
                      ))}
                    </p>
                  ) : (
                    <p
                      className="text-[11px] text-[#a08c7c] italic mt-2"
                      data-testid={`pillar-keywords-none-${p.id}`}
                    >
                      No routing terms — reached via fallback only
                    </p>
                  )}
                  {empty && (
                    <p className="text-xs text-[#8a6a5a] mt-1">
                      {p.pendingInviteCount > 0
                        ? "No faculty yet · invite sent, awaiting acceptance"
                        : "No faculty yet"}
                    </p>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => openInvite(p)}
                  className={`mt-3 w-fit text-xs px-3 py-1.5 rounded-lg font-medium transition ${
                    empty
                      ? "bg-[#8C1515] text-white hover:bg-[#a01a1a]"
                      : "border border-[#E8DDD0] text-[#8C1515] hover:border-[#8C1515]"
                  }`}
                  data-testid={`button-invite-pillar-${p.id}`}
                >
                  {empty ? "Invite a steward" : "Invite into this pillar"}
                </button>
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-[#E8DDD0]">
                  <button
                    type="button"
                    onClick={() => setEditingPillar(p)}
                    className="text-xs text-[#572020] hover:text-[#8C1515] underline"
                    data-testid={`button-edit-pillar-${p.id}`}
                  >
                    Rename
                  </button>
                  <PillarRetireButton pillar={p} />
                  <PillarDeleteButton pillar={p} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mb-10" data-testid="admin-channels-section">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="font-serif text-2xl font-medium">
            Distribution channels
          </h2>
          <button
            type="button"
            onClick={() => setCreatingChannel(true)}
            className="bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition shrink-0"
            data-testid="button-new-channel"
          >
            + New channel
          </button>
        </div>
        <p className="text-[#8a6a5a] mb-4 text-sm max-w-2xl">
          The cards every steward sees on their{" "}
          <strong>Distribution Channels</strong> page. A channel either opens a
          built-in destination (newsletter, ParentData, Matt), links out to a
          URL, or — when set to <strong>Soon</strong> with neither — shows a
          “notify me” control stewards can opt into. Built-in destinations are
          engineered separately; new ones aren’t selectable here.
        </p>
        {adminChannelsQuery.isLoading && (
          <p className="text-[#8a6a5a] text-sm">Loading channels…</p>
        )}
        {adminChannelsQuery.error && (
          <p
            className="text-[#E8352A] text-sm"
            data-testid="text-channels-error"
          >
            {(adminChannelsQuery.error as Error).message}
          </p>
        )}
        {adminChannelsQuery.data &&
          adminChannelsQuery.data.channels.length === 0 && (
            <p
              className="text-[#8a6a5a] text-sm"
              data-testid="text-channels-empty"
            >
              No channels yet. Add the first one.
            </p>
          )}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {(adminChannelsQuery.data?.channels ?? []).map((c) => {
            const destination = c.outlet
              ? `Built-in · ${c.outlet}`
              : c.href
                ? "External link"
                : "Notify-me only";
            return (
              <div
                key={c.id}
                className="text-left border rounded-xl p-4 transition flex flex-col border-[#E8DDD0]"
                data-testid={`card-channel-${c.id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[10px] tracking-[0.15em] uppercase text-[#a08c7c] mb-0.5">
                      {c.category || "—"}
                    </p>
                    <span className="font-serif text-lg text-[#572020] leading-snug block">
                      {c.name}
                      {c.isPrimary && (
                        <span
                          className="ml-2 align-middle text-[9px] not-italic font-sans bg-[#8C1515]/10 text-[#8C1515] px-1.5 py-0.5 rounded uppercase tracking-wide"
                          data-testid={`channel-primary-${c.id}`}
                        >
                          Primary
                        </span>
                      )}
                    </span>
                  </div>
                  <span className="flex-none mt-0.5">
                    <span
                      className={`text-[10px] tracking-[0.15em] uppercase px-2 py-1 rounded ${
                        c.status === "live"
                          ? "bg-[#8C1515]/10 text-[#8C1515]"
                          : "bg-[#E8DDD0] text-[#8a6a5a]"
                      }`}
                      data-testid={`channel-status-${c.id}`}
                    >
                      {c.status}
                    </span>
                  </span>
                </div>
                <p className="text-[11px] text-[#a08c7c] font-mono mt-0.5">
                  {c.key}
                </p>
                <p className="text-sm text-[#8a6a5a] mt-1.5 leading-relaxed line-clamp-3">
                  {c.description || (
                    <span className="italic text-[#a08c7c]">
                      No description
                    </span>
                  )}
                </p>
                <p className="text-xs text-[#8a6a5a] mt-2">{destination}</p>
                {c.href && (
                  <a
                    href={c.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-[#8C1515] underline hover:no-underline truncate mt-0.5"
                    data-testid={`channel-href-${c.id}`}
                    title={c.href}
                  >
                    {c.href}
                  </a>
                )}
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-[#E8DDD0]">
                  <button
                    type="button"
                    onClick={() => setEditingChannel(c)}
                    className="text-xs text-[#572020] hover:text-[#8C1515] underline"
                    data-testid={`button-edit-channel-${c.id}`}
                  >
                    Edit
                  </button>
                  <ChannelDeleteButton channel={c} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mb-10" data-testid="admin-channel-interest-section">
        <h2 className="font-serif text-2xl font-medium mb-1">
          Upcoming-channel interest
        </h2>
        <p className="text-[#8a6a5a] mb-4 text-sm max-w-2xl">
          Stewards who've raised their hand for a channel that isn't live yet
          (the dimmed “Soon” cards in their portal). Use this to see which
          upcoming channels have the most demand.
        </p>
        {channelInterestQuery.isLoading && (
          <p className="text-[#8a6a5a] text-sm">Loading interest…</p>
        )}
        {channelInterestQuery.error && (
          <p
            className="text-[#E8352A] text-sm"
            data-testid="text-channel-interest-error"
          >
            {(channelInterestQuery.error as Error).message}
          </p>
        )}
        {channelInterestQuery.data &&
          channelInterestQuery.data.channels.length === 0 && (
            <p
              className="text-[#8a6a5a] text-sm"
              data-testid="text-channel-interest-empty"
            >
              No steward has registered interest in an upcoming channel yet.
            </p>
          )}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {(channelInterestQuery.data?.channels ?? []).map((ch) => (
            <div
              key={ch.channelKey}
              className="border border-[#E8DDD0] rounded-xl p-4"
              data-testid={`channel-interest-${ch.channelKey}`}
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="font-serif text-lg text-[#572020]">
                  {CHANNEL_KEY_LABELS[ch.channelKey] ?? ch.channelKey}
                </span>
                <span
                  className="text-[11px] px-2 py-0.5 rounded-full bg-[#E3F0E3] text-[#2f6b3a]"
                  data-testid={`channel-interest-count-${ch.channelKey}`}
                >
                  {ch.count} interested
                </span>
              </div>
              <ul className="space-y-1">
                {ch.members.map((m) => (
                  <li
                    key={m.userId}
                    className="text-sm text-[#8a6a5a] truncate"
                    title={m.email}
                  >
                    {m.fullName || m.email}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {membersQuery.isLoading && <p className="text-[#8a6a5a]">Loading…</p>}
      {membersQuery.error && (
        <p className="text-[#E8352A]" data-testid="text-members-error">
          {(membersQuery.error as Error).message}
        </p>
      )}

      {filter && (
        <div
          className="flex items-center flex-wrap gap-2 mb-4 text-sm"
          data-testid="roster-active-filter"
        >
          <span className="text-[#8a6a5a]">Filtered by</span>
          <span className="font-medium text-[#572020] bg-[#F3E9D8] px-2.5 py-1 rounded-full">
            {rosterFilterLabel(filter)}
          </span>
          <span className="text-[#8a6a5a]">
            {visibleMembers.length} of {members.length}
          </span>
          <button
            onClick={() => setFilter(null)}
            className="text-[#8C1515] underline hover:no-underline font-medium"
            data-testid="button-clear-filter"
          >
            Clear filter
          </button>
        </div>
      )}

      {deactivatedCount > 0 && !isolatingDeactivated && (
        <div
          className="flex items-center flex-wrap gap-3 mb-4 text-sm"
          data-testid="roster-removed-control"
        >
          <span className="text-[#8a6a5a]">
            {deactivatedCount} removed{" "}
            {deactivatedCount === 1 ? "member" : "members"}
          </span>
          <button
            type="button"
            onClick={() => setShowDeactivated((v) => !v)}
            className="text-[#8C1515] underline hover:no-underline font-medium"
            data-testid="button-toggle-removed"
          >
            {showDeactivated ? "Hide removed" : "Show removed"}
          </button>
          <button
            type="button"
            onClick={() => toggleFilter({ kind: "deactivated" })}
            className="text-[#8C1515] underline hover:no-underline font-medium"
            data-testid="button-only-removed"
          >
            Show only removed
          </button>
        </div>
      )}

      <div className="space-y-3">
        {filter && visibleMembers.length === 0 && (
          <p className="text-[#8a6a5a]">No members match this filter.</p>
        )}
        {visibleMembers.map((m) => {
          const status = memberStatus(m);
          const deactivated = m.deactivatedAt != null;
          const isArchived = m.archivedAt != null;
          return (
            <div
              key={m.id}
              className={`border border-[#E8DDD0] rounded-xl p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4 ${
                deactivated
                  ? "opacity-60 bg-[#FBF7F0]"
                  : isArchived
                    ? "opacity-75 bg-[#F9F5EE]"
                    : ""
              }`}
              data-testid={`row-member-${m.id}`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-serif text-lg">
                    {m.fullName ?? "—"}
                  </span>
                  {deactivated && (
                    <button
                      type="button"
                      onClick={() => toggleFilter({ kind: "deactivated" })}
                      className="text-[9px] tracking-[0.2em] uppercase bg-[#E8352A] text-white px-2 py-0.5 rounded cursor-pointer hover:brightness-110 transition"
                      title="Removed — sign-in disabled, no pillars. Filter to removed members."
                      data-testid={`badge-deactivated-${m.id}`}
                    >
                      Removed
                    </button>
                  )}
                  {isArchived && !deactivated && (
                    <span
                      className="text-[9px] tracking-[0.2em] uppercase bg-[#F3E9D8] text-[#572020] border border-[#D4C4B0] px-2 py-0.5 rounded"
                      title="On leave — portal suspended; Clerk account active; memberships preserved."
                      data-testid={`badge-archived-${m.id}`}
                    >
                      On leave
                    </span>
                  )}
                  {m.clerkStatus === "banned" && (
                    <span
                      className="text-[9px] tracking-[0.2em] uppercase bg-[#572020] text-white px-2 py-0.5 rounded"
                      title="This member's sign-in account is banned in Clerk."
                      data-testid={`badge-clerk-banned-${m.id}`}
                    >
                      Sign-in banned
                    </span>
                  )}
                  {m.clerkStatus === "locked" && (
                    <span
                      className="text-[9px] tracking-[0.2em] uppercase bg-amber-500 text-white px-2 py-0.5 rounded"
                      title="Temporarily locked after too many failed sign-in attempts. Clears on its own after a few minutes, or unlock now."
                      data-testid={`badge-clerk-locked-${m.id}`}
                    >
                      Sign-in locked
                    </span>
                  )}
                  {m.registered && m.clerkStatus === "unknown" && (
                    <span
                      className="text-[9px] tracking-[0.2em] uppercase bg-[#EEE7DC] text-[#8a6a5a] px-2 py-0.5 rounded"
                      title="Couldn't determine this member's sign-in account status (Clerk unreachable or no matching account)."
                      data-testid={`badge-clerk-unknown-${m.id}`}
                    >
                      Sign-in status unknown
                    </span>
                  )}
                  {m.isPlatformAdmin && (
                    <button
                      type="button"
                      onClick={() => toggleFilter({ kind: "admin" })}
                      className="text-[9px] tracking-[0.2em] uppercase bg-[#572020] text-white px-2 py-0.5 rounded cursor-pointer hover:bg-[#7a2e2e] transition"
                      title="Filter to platform admins"
                      data-testid={`filter-admin-${m.id}`}
                    >
                      Admin
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => toggleFilter({ kind: "status", status })}
                    className={`text-[10px] px-2 py-0.5 rounded-full cursor-pointer transition hover:brightness-95 ${
                      status === "onboarded"
                        ? "bg-[#E3F0E3] text-[#2f6b3a]"
                        : status === "user"
                          ? "bg-[#DCE7F5] text-[#1f4e8c]"
                          : "bg-[#F3E0DE] text-[#8C1515]"
                    }`}
                    title={`Filter by ${
                      status === "onboarded"
                        ? "onboarded"
                        : status === "user"
                          ? "registered users"
                          : "invited"
                    }`}
                    data-testid={`status-onboarding-${m.id}`}
                  >
                    {MEMBER_STATUS_LABEL[status]}
                  </button>
                </div>
                <p className="text-sm text-[#8a6a5a] truncate">{m.email}</p>
                {m.clerkMismatch && (
                  <div
                    className="mt-2 border border-[#E8352A] bg-[#FDEDEC] rounded-lg px-3 py-2 text-xs text-[#8C1515] leading-relaxed"
                    data-testid={`warning-clerk-mismatch-${m.id}`}
                  >
                    {m.clerkStatus === "banned" ? (
                      <>
                        <strong>Sign-in mismatch:</strong> this member is active
                        here but their sign-in account is banned — they may be
                        silently locked out. Fix: open Edit and use “Remove
                        member” then “Reactivate” to re-sync their sign-in
                        access.
                      </>
                    ) : (
                      <>
                        <strong>Sign-in mismatch:</strong> this member is
                        removed here but their sign-in account is still active —
                        they may still be able to sign in. Fix: open Edit and
                        use “Reactivate” then “Remove member” to re-apply the
                        sign-in block.
                      </>
                    )}
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {m.memberships.map((mm) => (
                    <span
                      key={mm.pillarId}
                      className="inline-flex items-center gap-1"
                    >
                      <button
                        type="button"
                        onClick={() =>
                          toggleFilter({
                            kind: "role",
                            pillarId: mm.pillarId,
                            role: mm.role,
                            pillarName: mm.pillarName,
                          })
                        }
                        className={`text-[10px] px-2 py-0.5 rounded-full cursor-pointer transition hover:brightness-95 ${
                          memberRoleStyle[mm.role] ??
                          "bg-[#EEE7DC] text-[#8a6a5a]"
                        }`}
                        title={`Filter by ${mm.pillarName} · ${mm.role}${mm.isCustodianHeld ? " — custodian is co-steward (temporary handoff)" : ""}`}
                        data-testid={`filter-role-${m.id}-${mm.pillarId}`}
                      >
                        {mm.pillarName} · {mm.role}
                      </button>
                      {mm.isCustodianHeld && (
                        <span
                          className="text-[9px] tracking-[0.12em] uppercase bg-amber-100 text-amber-800 border border-amber-200 px-1.5 py-0.5 rounded-full"
                          title="Custodian is co-steward on this pillar — temporary handoff while a permanent steward is found"
                          data-testid={`badge-custodian-held-${m.id}-${mm.pillarId}`}
                        >
                          Custodian
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
              <div className="shrink-0 flex items-center gap-2">
                {viewAs ? (
                  <span
                    className="text-xs text-[#8a6a5a] italic"
                    data-testid={`text-readonly-${m.id}`}
                  >
                    Read-only preview
                  </span>
                ) : (
                  <>
                    {m.clerkStatus === "locked" && (
                      <UnlockMemberButton member={m} />
                    )}
                    <button
                      onClick={() => setEditing(m)}
                      className="border border-[#E8DDD0] text-[#572020] px-4 py-2 rounded-lg text-sm font-medium hover:border-[#8C1515] transition"
                      data-testid={`button-edit-${m.id}`}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => preview(m)}
                      className="bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition"
                      data-testid={`button-preview-${m.id}`}
                    >
                      Preview dashboard →
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <section
        className="mt-14 border-t border-[#E8DDD0] pt-10"
        data-testid="admin-newsletter-section"
      >
        <p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-3">
          Admin · Newsletter
        </p>
        <h2 className="font-serif text-2xl font-medium mb-2">
          Newsletter dashboard
        </h2>
        <p className="text-[#8a6a5a] mb-6 leading-relaxed max-w-2xl text-sm">
          Create issues, curate and order posts, generate drafts and images,
          then send or export — the same dashboard the newsletter editors use.
          Your platform-admin sign-in grants access; no separate login needed.
        </p>

        {!newsletterOpen ? (
          <button
            onClick={openNewsletter}
            className="bg-[#8C1515] text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition"
            data-testid="button-open-newsletter"
          >
            Open newsletter dashboard →
          </button>
        ) : newsletterError ? (
          <div className="text-sm">
            <p
              className="text-[#E8352A] mb-2"
              data-testid="text-newsletter-error"
            >
              Couldn’t open the dashboard: {newsletterError}
            </p>
            <button
              onClick={openNewsletter}
              className="text-[#8C1515] underline hover:no-underline font-medium"
            >
              Try again
            </button>
          </div>
        ) : !newsletterReady ? (
          <p className="text-[#8a6a5a] text-sm">Preparing your session…</p>
        ) : (
          <div className="rounded-xl overflow-hidden border border-[#E8DDD0] bg-white">
            <iframe
              src="/newsletter-admin"
              title="Newsletter dashboard"
              className="w-full"
              style={{ height: "82vh", border: "none" }}
              data-testid="iframe-newsletter"
            />
          </div>
        )}
      </section>

      {editing && (
        <EditMemberDialog
          member={editing}
          pillars={pillarsQuery.data?.pillars ?? []}
          isSelf={me?.user.id === editing.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["faculty-admin-members"] });
            qc.invalidateQueries({ queryKey: ["faculty-admin-pillars"] });
          }}
        />
      )}

      {creatingPillar && (
        <PillarFormDialog
          onClose={() => setCreatingPillar(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["faculty-admin-pillars"] });
          }}
        />
      )}

      {editingPillar && (
        <PillarFormDialog
          pillar={editingPillar}
          onClose={() => setEditingPillar(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["faculty-admin-pillars"] });
          }}
        />
      )}

      {creatingChannel && (
        <ChannelFormDialog
          onClose={() => setCreatingChannel(false)}
          onSaved={() => {
            qc.invalidateQueries({
              queryKey: ["faculty-admin-distribution-channels"],
            });
            qc.invalidateQueries({
              queryKey: ["faculty-distribution-channels"],
            });
          }}
        />
      )}

      {editingChannel && (
        <ChannelFormDialog
          channel={editingChannel}
          onClose={() => setEditingChannel(null)}
          onSaved={() => {
            qc.invalidateQueries({
              queryKey: ["faculty-admin-distribution-channels"],
            });
            qc.invalidateQueries({
              queryKey: ["faculty-distribution-channels"],
            });
          }}
        />
      )}

      {inviteFor && (
        <div
          className="fixed inset-0 z-[120] bg-black/30 flex items-center justify-center p-4"
          onClick={closeInvite}
          data-testid="modal-invite-pillar"
        >
          <div
            className="bg-[#FBF7F0] border border-[#E8DDD0] rounded-2xl p-6 w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-2">
              Invite faculty
            </p>
            <h2 className="font-serif text-2xl font-medium mb-1">
              {inviteFor.name}
            </h2>
            <p className="text-sm text-[#8a6a5a] mb-5">
              {inviteFor.facultyCount === 0
                ? "This pillar has no faculty yet. Invite a steward to lead it — they'll land directly in this pillar after accepting."
                : "Invite someone into this pillar. They'll land directly here after accepting."}
            </p>
            <div className="flex flex-col gap-3">
              <input
                type="email"
                required
                placeholder="email@stanford.edu"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="bg-white border border-[#E8DDD0] rounded-lg px-4 py-2 text-[#572020]"
                data-testid="input-invite-pillar-email"
              />
              <select
                value={inviteRole}
                onChange={(e) =>
                  setInviteRole(
                    e.target.value as
                      | "steward"
                      | "contributor"
                      | "advisor"
                      | "viewer",
                  )
                }
                className="bg-white border border-[#E8DDD0] rounded-lg px-4 py-2 text-[#572020]"
                data-testid="select-invite-pillar-role"
              >
                <option value="steward">Steward</option>
                <option value="contributor">Contributor</option>
                <option value="advisor">Advisor (cross-pillar lens)</option>
                <option value="viewer">Viewer</option>
              </select>
              <input
                type="text"
                placeholder="Institution (optional) — e.g. Stanford Medicine"
                value={inviteInstitution}
                onChange={(e) => setInviteInstitution(e.target.value)}
                className="bg-white border border-[#E8DDD0] rounded-lg px-4 py-2 text-[#572020]"
                data-testid="input-invite-pillar-institution"
              />
              <p className="text-xs text-[#8a6a5a] -mt-1">
                Shown as a “from [Institution]” byline credit. Leave blank for
                Stanford / name-only.
              </p>
              <select
                value={inviteChannel}
                onChange={(e) =>
                  setInviteChannel(e.target.value as "standard" | "aslm")
                }
                className="bg-white border border-[#E8DDD0] rounded-lg px-4 py-2 text-[#572020]"
                data-testid="select-invite-pillar-channel"
              >
                <option value="standard">Standard registration</option>
                <option value="aslm">Via AskLifestyleMedicine</option>
              </select>
              <p className="text-xs text-[#8a6a5a] -mt-1">
                “Via AskLifestyleMedicine” members see a trimmed portal:
                Workspace and Pillar Settings only.
              </p>
              <div className="flex items-center gap-2 mt-1">
                <button
                  onClick={() =>
                    inviteEmail &&
                    inviteMutation.mutate({
                      email: inviteEmail,
                      role: inviteRole,
                      pillarId: inviteFor.id,
                      institution: inviteInstitution.trim() || undefined,
                      channel: inviteChannel === "aslm" ? "aslm" : undefined,
                    })
                  }
                  disabled={inviteMutation.isPending || !inviteEmail}
                  className="bg-[#8C1515] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#a01a1a] disabled:opacity-50 transition"
                  data-testid="button-send-invite-pillar"
                >
                  {inviteMutation.isPending ? "Sending…" : "Send invitation"}
                </button>
                <button
                  onClick={closeInvite}
                  className="px-4 py-2 rounded-lg font-medium text-[#8a6a5a] hover:text-[#572020] transition"
                  data-testid="button-cancel-invite-pillar"
                >
                  Close
                </button>
              </div>
              {inviteMsg && (
                <p
                  className="text-sm text-[#8a6a5a]"
                  data-testid="text-invite-pillar-msg"
                >
                  {inviteMsg}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
      <AdminCrawlTalks />
    </PortalShell>
  );
}

interface CrawlTarget {
  id: number;
  fullName: string | null;
  email: string;
  pillars: Array<{ id: number; name: string; slug: string }>;
}

interface CrawlRunSummary {
  id: number;
  facultyUserId: number;
  pillarId: number;
  speakerName: string;
  rightsBasis:
    | "open_license"
    | "permission"
    | "public_domain"
    | "no_documented_full_text_rights"
    | null;
  status:
    | "pending"
    | "discovering"
    | "review"
    | "collecting"
    | "done"
    | "failed";
  error: string | null;
  createdAt: string;
  updatedAt: string;
  pillarName: string | null;
}

interface CrawlCandidate {
  id: number;
  status:
    | "discovered"
    | "fetching"
    | "transcribed"
    | "ingested"
    | "failed"
    | "discarded";
  title: string;
  sourceType: string;
  eventName: string | null;
  primaryUrl: string;
  transcriptAvailable: boolean;
  sourceId: number | null;
  interpretationId: number | null;
  error: string | null;
}

const crawlStatusStyle: Record<string, string> = {
  pending: "bg-[#EEE7DC] text-[#8a6a5a]",
  discovering: "bg-[#E6ECF6] text-[#2a4d8f]",
  review: "bg-[#FBEFD6] text-[#8a6512]",
  collecting: "bg-[#E6ECF6] text-[#2a4d8f]",
  done: "bg-[#E4F0E4] text-[#2f6b34]",
  failed: "bg-[#F7E0DE] text-[#8C1515]",
  discovered: "bg-[#EEE7DC] text-[#8a6a5a]",
  fetching: "bg-[#E6ECF6] text-[#2a4d8f]",
  transcribed: "bg-[#E6ECF6] text-[#2a4d8f]",
  ingested: "bg-[#E4F0E4] text-[#2f6b34]",
  discarded: "bg-[#EEE7DC] text-[#8a6a5a]",
};

/**
 * Admin "Crawl talks" surface (Task #168). Platform-admins pick a faculty
 * member + pillar, optionally paste appearance URLs, and trigger a background
 * crawl that discovers talks/podcasts/interviews, transcribes them, ingests
 * them as `talk` sources, and drafts PROPOSED interpretations into that
 * pillar's steward queue. The panel polls the active run until it finishes.
 */
function AdminCrawlTalks() {
  const [facultyId, setFacultyId] = useState<number | null>(null);
  const [pillarId, setPillarId] = useState<number | null>(null);
  const [rightsBasis, setRightsBasis] = useState("");
  const [urlsText, setUrlsText] = useState("");
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const targetsQuery = useQuery<{ targets: CrawlTarget[] }>({
    queryKey: ["faculty-admin-crawl-targets"],
    queryFn: () => fetchJson("/api/faculty/admin/crawls-targets"),
  });
  const runsQuery = useQuery<{
    firecrawlConfigured: boolean;
    runs: CrawlRunSummary[];
  }>({
    queryKey: ["faculty-admin-crawls"],
    queryFn: () => fetchJson("/api/faculty/admin/crawls"),
    refetchInterval: 5000,
  });

  const runDetailQuery = useQuery<{
    run: CrawlRunSummary & { pillarSlug: string | null };
    candidates: CrawlCandidate[];
  }>({
    queryKey: ["faculty-admin-crawl-run", activeRunId],
    queryFn: () => fetchJson(`/api/faculty/admin/crawls/${activeRunId}`),
    enabled: activeRunId != null,
    refetchInterval: (q) => {
      const s = q.state.data?.run.status;
      return s === "done" || s === "failed" ? false : 2500;
    },
  });

  const targets = targetsQuery.data?.targets ?? [];
  const selectedTarget = targets.find((t) => t.id === facultyId) ?? null;
  const firecrawlConfigured = runsQuery.data?.firecrawlConfigured ?? false;

  const startMutation = useMutation({
    mutationFn: (body: {
      facultyUserId: number;
      pillarId: number;
      pastedUrls?: string[];
      rightsBasis: string;
    }) =>
      fetchJson<{ runId: number }>("/api/faculty/admin/crawls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      setActiveRunId(data.runId);
      setError(null);
      void runsQuery.refetch();
    },
    onError: (e) => setError((e as Error).message),
  });

  function start(): void {
    if (facultyId == null || pillarId == null) return;
    const pastedUrls = urlsText
      .split(/\s+/)
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//i.test(u));
    startMutation.mutate({
      facultyUserId: facultyId,
      pillarId,
      pastedUrls: pastedUrls.length > 0 ? pastedUrls : undefined,
      rightsBasis,
    });
  }

  const candidateActionMutation = useMutation({
    mutationFn: ({ id, action }: { id: number; action: "retry" | "discard" }) =>
      fetchJson(`/api/faculty/admin/crawls/candidates/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      }),
    onSuccess: () => {
      setError(null);
      void runDetailQuery.refetch();
    },
    onError: (e) => setError((e as Error).message),
  });

  const collectMutation = useMutation({
    mutationFn: (runId: number) =>
      fetchJson(`/api/faculty/admin/crawls/${runId}/collect`, {
        method: "POST",
      }),
    onSuccess: () => {
      setError(null);
      void runDetailQuery.refetch();
      void runsQuery.refetch();
    },
    onError: (e) => setError((e as Error).message),
  });

  const candidates = runDetailQuery.data?.candidates ?? [];

  return (
    <section className="mt-12 mb-10" data-testid="admin-crawl-section">
      <h2 className="font-serif text-2xl font-medium mb-1">Crawl talks</h2>
      <p className="text-[#8a6a5a] mb-4 text-sm max-w-2xl">
        Discover a faculty member’s talks, podcasts, and interviews; transcribe
        them; and ingest each as a citable <strong>talk</strong> source with an
        AI-drafted interpretation queued for that pillar’s steward to review.{" "}
        <strong>Nothing goes live until a steward approves it.</strong> One
        faculty member per run.
      </p>
      {!firecrawlConfigured && (
        <p
          className="text-xs text-[#8C1515] bg-[#F7E0DE] rounded-lg px-3 py-2 mb-4 max-w-2xl"
          data-testid="text-firecrawl-warning"
        >
          Automatic web discovery is off (FIRECRAWL_API_KEY not set). You can
          still run a crawl by pasting appearance URLs below.
        </p>
      )}

      <div className="bg-white border border-[#E8DDD0] rounded-xl p-4 max-w-2xl mb-6 grid gap-3">
        <label className="grid gap-1">
          <span className="text-xs uppercase tracking-wider text-[#8a6a5a]">
            Faculty member
          </span>
          <select
            value={facultyId ?? ""}
            onChange={(e) => {
              const v = e.target.value ? Number(e.target.value) : null;
              setFacultyId(v);
              setPillarId(null);
            }}
            className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-[#572020]"
            data-testid="select-crawl-faculty"
          >
            <option value="">Select a faculty member…</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.fullName ?? t.email}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-xs uppercase tracking-wider text-[#8a6a5a]">
            Rights basis for collected transcripts
          </span>
          <select
            value={rightsBasis}
            onChange={(e) => setRightsBasis(e.target.value)}
            className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-[#572020]"
            data-testid="select-crawl-rights-basis"
          >
            <option value="">Select a documented basis…</option>
            <option value="open_license">Open licence</option>
            <option value="permission">
              Permission to process the full text
            </option>
            <option value="public_domain">Public domain</option>
            <option value="no_documented_full_text_rights">
              No documented full-text rights — temporary review only
            </option>
          </select>
          <span className="text-xs text-[#8a6a5a]">
            With no documented full-text rights, a steward-approved original
            interpretation can remain, but the transcript and its embeddings are
            deleted on final approval.
          </span>
        </label>

        <label className="grid gap-1">
          <span className="text-xs uppercase tracking-wider text-[#8a6a5a]">
            Pillar
          </span>
          <select
            value={pillarId ?? ""}
            onChange={(e) =>
              setPillarId(e.target.value ? Number(e.target.value) : null)
            }
            disabled={!selectedTarget || selectedTarget.pillars.length === 0}
            className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-[#572020] disabled:opacity-50"
            data-testid="select-crawl-pillar"
          >
            <option value="">
              {selectedTarget && selectedTarget.pillars.length === 0
                ? "This member holds no pillars"
                : "Select a pillar…"}
            </option>
            {(selectedTarget?.pillars ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-1">
          <span className="text-xs uppercase tracking-wider text-[#8a6a5a]">
            Appearance URLs (optional, one per line)
          </span>
          <textarea
            value={urlsText}
            onChange={(e) => setUrlsText(e.target.value)}
            rows={3}
            placeholder={
              "https://podcast.example/episode-123\nhttps://site.example/talk.mp3"
            }
            className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-[#572020] text-sm font-mono"
            data-testid="input-crawl-urls"
          />
          <span className="text-xs text-[#8a6a5a]">
            Paste transcript pages, podcast episode pages, direct audio (mp3)
            links, or YouTube videos (captions are pulled when available).
          </span>
        </label>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={start}
            disabled={
              facultyId == null ||
              pillarId == null ||
              !rightsBasis ||
              startMutation.isPending
            }
            className="bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] disabled:opacity-50 transition"
            data-testid="button-start-crawl"
          >
            {startMutation.isPending ? "Starting…" : "Start crawl"}
          </button>
          {error && (
            <span
              className="text-sm text-[#8C1515]"
              data-testid="text-crawl-error"
            >
              {error}
            </span>
          )}
        </div>
      </div>

      {runDetailQuery.data && (
        <div
          className="bg-[#F9F5EE] border border-[#E8DDD0] rounded-xl p-4 max-w-3xl mb-6"
          data-testid="crawl-active-run"
        >
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="font-serif text-lg font-medium">
                {runDetailQuery.data.run.speakerName}
              </p>
              <p className="text-xs text-[#8a6a5a]">
                {runDetailQuery.data.run.pillarName} · run #
                {runDetailQuery.data.run.id}
              </p>
            </div>
            <span
              className={`text-xs px-2 py-1 rounded-full ${crawlStatusStyle[runDetailQuery.data.run.status] ?? ""}`}
              data-testid="text-run-status"
            >
              {runDetailQuery.data.run.status}
            </span>
          </div>
          {runDetailQuery.data.run.error && (
            <p className="text-sm text-[#8C1515] mb-3">
              {runDetailQuery.data.run.error}
            </p>
          )}
          {runDetailQuery.data.run.status === "review" &&
            candidates.length > 0 && (
              <div
                className="bg-[#FBEFD6] border border-[#EAD9A8] rounded-lg px-3 py-3 mb-3 flex items-start justify-between gap-3 flex-wrap"
                data-testid="crawl-review-banner"
              >
                <p className="text-sm text-[#8a6512] max-w-md">
                  Review the discovered appearances below and discard any that
                  are the wrong person, off-topic, or duplicates. Nothing is
                  transcribed or ingested until you start collection.
                </p>
                <button
                  type="button"
                  onClick={() =>
                    collectMutation.mutate(runDetailQuery.data!.run.id)
                  }
                  disabled={
                    collectMutation.isPending ||
                    candidates.every((c) => c.status === "discarded")
                  }
                  className="bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] disabled:opacity-50 transition shrink-0"
                  data-testid="button-collect-crawl"
                >
                  {collectMutation.isPending
                    ? "Starting…"
                    : `Collect ${
                        candidates.filter((c) => c.status !== "discarded")
                          .length
                      } kept · start ingest`}
                </button>
              </div>
            )}
          {candidates.length === 0 ? (
            <p className="text-sm text-[#8a6a5a]">
              {runDetailQuery.data.run.status === "discovering"
                ? "Discovering appearances…"
                : "No candidates yet."}
            </p>
          ) : (
            <ul className="grid gap-2">
              {candidates.map((c) => (
                <li
                  key={c.id}
                  className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2"
                  data-testid={`crawl-candidate-${c.id}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <a
                        href={c.primaryUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-[#572020] hover:text-[#8C1515] truncate block"
                      >
                        {c.title}
                      </a>
                      <p className="text-xs text-[#8a6a5a]">
                        {c.sourceType}
                        {c.interpretationId
                          ? " · drafted for steward review"
                          : ""}
                      </p>
                      {c.error && (
                        <p className="text-xs text-[#8C1515] mt-1">{c.error}</p>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span
                        className={`text-[10px] px-2 py-1 rounded-full ${crawlStatusStyle[c.status] ?? ""}`}
                      >
                        {c.status}
                      </span>
                      {c.status !== "ingested" &&
                        c.status !== "discarded" &&
                        c.status !== "fetching" && (
                          <div className="flex items-center gap-2">
                            {c.status === "failed" && (
                              <button
                                type="button"
                                onClick={() =>
                                  candidateActionMutation.mutate({
                                    id: c.id,
                                    action: "retry",
                                  })
                                }
                                disabled={candidateActionMutation.isPending}
                                className="text-[10px] text-[#2a4d8f] hover:underline disabled:opacity-50"
                                data-testid={`button-retry-candidate-${c.id}`}
                              >
                                Retry
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                candidateActionMutation.mutate({
                                  id: c.id,
                                  action: "discard",
                                })
                              }
                              disabled={candidateActionMutation.isPending}
                              className="text-[10px] text-[#8a6a5a] hover:underline disabled:opacity-50"
                              data-testid={`button-discard-candidate-${c.id}`}
                            >
                              Discard
                            </button>
                          </div>
                        )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div>
        <h3 className="font-serif text-lg font-medium mb-2">Recent runs</h3>
        {(runsQuery.data?.runs ?? []).length === 0 ? (
          <p className="text-sm text-[#8a6a5a]">No crawls yet.</p>
        ) : (
          <ul className="grid gap-1 max-w-3xl">
            {(runsQuery.data?.runs ?? []).map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setActiveRunId(r.id)}
                  className="w-full text-left bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 hover:border-[#8C1515] transition flex items-center justify-between gap-3"
                  data-testid={`crawl-run-${r.id}`}
                >
                  <span className="text-sm text-[#572020] truncate">
                    {r.speakerName}
                    <span className="text-[#8a6a5a]">
                      {" "}
                      · {r.pillarName ?? "—"}
                    </span>
                  </span>
                  <span
                    className={`text-[10px] px-2 py-1 rounded-full shrink-0 ${crawlStatusStyle[r.status] ?? ""}`}
                  >
                    {r.status}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * Create-or-rename dialog for a pillar. With `pillar` set it renames (name +
 * description, slug shown read-only); without it, it creates a new pillar
 * (name + slug + description). Slug is immutable after creation because it
 * appears in embed links and public routes.
 */
function PillarFormDialog({
  pillar,
  onClose,
  onSaved,
}: {
  pillar?: AdminPillar;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!pillar;
  const [name, setName] = useState(pillar?.name ?? "");
  const [slug, setSlug] = useState(pillar?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState(pillar?.description ?? "");
  const [msg, setMsg] = useState<string | null>(null);

  function slugify(v: string): string {
    return v
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        description: description.trim() || undefined,
        ...(isEdit ? {} : { slug: slug.trim() }),
      };
      return fetchJson(
        isEdit
          ? `/api/faculty/admin/pillars/${pillar!.id}`
          : "/api/faculty/admin/pillars",
        {
          method: isEdit ? "PATCH" : "POST",
          body: JSON.stringify(body),
        },
      );
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (e) => setMsg((e as Error).message),
  });

  const slugValid = isEdit || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.trim());
  const canSave = name.trim().length > 0 && slugValid && !save.isPending;

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
      data-testid="dialog-pillar-form"
    >
      <div
        className="bg-[#FBF7F0] border border-[#E8DDD0] rounded-2xl w-full max-w-md p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <h2 className="font-serif text-2xl">
            {isEdit ? "Rename pillar" : "New pillar"}
          </h2>
          <button
            onClick={onClose}
            className="text-[#8a6a5a] hover:text-[#572020] text-xl leading-none"
            data-testid="button-close-pillar"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <label className="block text-[11px] tracking-[0.15em] uppercase text-[#8a6a5a] mb-1">
          Name
        </label>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setMsg(null);
            if (!isEdit && !slugTouched) setSlug(slugify(e.target.value));
          }}
          className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 mb-3 bg-white focus:border-[#8C1515] outline-none"
          data-testid="input-pillar-name"
          placeholder="e.g. Purpose & Meaning"
        />

        <label className="block text-[11px] tracking-[0.15em] uppercase text-[#8a6a5a] mb-1">
          Slug
        </label>
        {isEdit ? (
          <p
            className="text-sm font-mono text-[#8a6a5a] mb-3"
            data-testid="text-pillar-slug-readonly"
          >
            {pillar!.slug}{" "}
            <span className="text-xs not-italic font-sans">
              (immutable — used in embed links)
            </span>
          </p>
        ) : (
          <>
            <input
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugTouched(true);
                setMsg(null);
              }}
              className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 mb-1 bg-white focus:border-[#8C1515] outline-none font-mono text-sm"
              data-testid="input-pillar-slug"
              placeholder="purpose-and-meaning"
            />
            <p className="text-xs text-[#8a6a5a] mb-3">
              Lowercase letters, numbers and hyphens. Used in URLs and embed
              snippets — can’t be changed later.
            </p>
          </>
        )}

        <label className="block text-[11px] tracking-[0.15em] uppercase text-[#8a6a5a] mb-1">
          Description
        </label>
        <textarea
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            setMsg(null);
          }}
          rows={3}
          className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 mb-4 bg-white focus:border-[#8C1515] outline-none text-sm"
          data-testid="input-pillar-description"
          placeholder="What this coverage area is about"
        />

        <div className="flex items-center gap-3">
          <button
            onClick={() => save.mutate()}
            disabled={!canSave}
            className="bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition disabled:opacity-40"
            data-testid="button-save-pillar"
          >
            {save.isPending
              ? "Saving…"
              : isEdit
                ? "Save changes"
                : "Create pillar"}
          </button>
          {msg && (
            <span
              className="text-xs text-[#E8352A]"
              data-testid="text-pillar-error"
            >
              {msg}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Retire / restore toggle for a pillar (soft hide, preserves content). */
function PillarRetireButton({ pillar }: { pillar: AdminPillar }) {
  const qc = useQueryClient();
  const retired = pillar.retiredAt != null;
  const toggle = useMutation({
    mutationFn: () =>
      fetchJson(`/api/faculty/admin/pillars/${pillar.id}/retire`, {
        method: "POST",
        body: JSON.stringify({ retired: !retired }),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["faculty-admin-pillars"] }),
  });
  return (
    <button
      type="button"
      onClick={() => toggle.mutate()}
      disabled={toggle.isPending}
      className="text-xs text-[#572020] hover:text-[#8C1515] underline disabled:opacity-40"
      data-testid={`button-retire-pillar-${pillar.id}`}
    >
      {toggle.isPending ? "…" : retired ? "Restore" : "Retire"}
    </button>
  );
}

/**
 * Delete a pillar. A first click that the server refuses (409 — pillar still
 * has faculty/sources/interpretations) surfaces a confirmation prompt that
 * spells out exactly what would be destroyed; confirming re-sends with
 * `?force=true`. Empty pillars delete immediately on confirm.
 */
function PillarDeleteButton({ pillar }: { pillar: AdminPillar }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<null | {
    facultyCount: number;
    sourceCount: number;
    interpretationCount: number;
  }>(null);

  const del = useMutation({
    mutationFn: (force: boolean) =>
      fetchJson(
        `/api/faculty/admin/pillars/${pillar.id}${force ? "?force=true" : ""}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      setConfirm(null);
      qc.invalidateQueries({ queryKey: ["faculty-admin-pillars"] });
    },
  });

  async function start(): Promise<void> {
    const empty =
      pillar.facultyCount === 0 &&
      pillar.sourceCount === 0 &&
      pillar.interpretationCount === 0;
    if (empty) {
      // Nothing to lose — confirm with a simple prompt, then hard delete.
      setConfirm({ facultyCount: 0, sourceCount: 0, interpretationCount: 0 });
      return;
    }
    try {
      await del.mutateAsync(false);
    } catch (e) {
      // fetchJson throws an Error whose message is the raw response body. On a
      // 409 that body is JSON with the content summary + requiresConfirmation.
      let body:
        | {
            requiresConfirmation?: boolean;
            facultyCount?: number;
            sourceCount?: number;
            interpretationCount?: number;
          }
        | undefined;
      try {
        body = JSON.parse((e as Error).message);
      } catch {
        body = undefined;
      }
      if (body?.requiresConfirmation) {
        setConfirm({
          facultyCount: body.facultyCount ?? pillar.facultyCount,
          sourceCount: body.sourceCount ?? pillar.sourceCount,
          interpretationCount:
            body.interpretationCount ?? pillar.interpretationCount,
        });
      }
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={start}
        disabled={del.isPending}
        className="text-xs text-[#E8352A] hover:underline disabled:opacity-40 ml-auto"
        data-testid={`button-delete-pillar-${pillar.id}`}
      >
        Delete
      </button>
      {confirm && (
        <div
          className="fixed inset-0 z-[210] bg-black/40 flex items-center justify-center p-4"
          onClick={() => setConfirm(null)}
          data-testid={`dialog-delete-pillar-${pillar.id}`}
        >
          <div
            className="bg-[#FBF7F0] border border-[#E8DDD0] rounded-2xl w-full max-w-md p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-serif text-2xl mb-2">
              Delete “{pillar.name}”?
            </h2>
            {confirm.facultyCount === 0 &&
            confirm.sourceCount === 0 &&
            confirm.interpretationCount === 0 ? (
              <p className="text-sm text-[#8a6a5a] mb-5">
                This pillar is empty. Deleting it is permanent. If you might
                offer it again later, retire it instead.
              </p>
            ) : (
              <p className="text-sm text-[#572020] mb-5">
                This pillar still has{" "}
                <strong>
                  {confirm.facultyCount} faculty membership
                  {confirm.facultyCount === 1 ? "" : "s"}
                </strong>
                ,{" "}
                <strong>
                  {confirm.sourceCount} source
                  {confirm.sourceCount === 1 ? "" : "s"}
                </strong>
                , and{" "}
                <strong>
                  {confirm.interpretationCount} interpretation
                  {confirm.interpretationCount === 1 ? "" : "s"}
                </strong>
                . Deleting will <strong>permanently remove all of it</strong>.
                This cannot be undone. To take the pillar out of rotation
                without losing content, retire it instead.
              </p>
            )}
            <div className="flex items-center gap-3">
              <button
                onClick={() => del.mutate(true)}
                disabled={del.isPending}
                className="bg-[#E8352A] text-white px-4 py-2 rounded-lg text-sm font-medium hover:brightness-95 transition disabled:opacity-40"
                data-testid={`button-confirm-delete-pillar-${pillar.id}`}
              >
                {del.isPending ? "Deleting…" : "Delete permanently"}
              </button>
              <button
                onClick={() => setConfirm(null)}
                className="text-[#572020] underline hover:no-underline text-sm"
                data-testid={`button-cancel-delete-pillar-${pillar.id}`}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Create / edit a Distribution Channels card. `key` is settable only on create
 * (it anchors interest rows and lives in code-side logic), and is auto-derived
 * from the name until the admin edits it directly — mirroring the pillar slug
 * field. The "built-in destination" (outlet) list is closed: those detail views
 * are engineered separately, so an admin can only pick from existing ones.
 */
function ChannelFormDialog({
  channel,
  onClose,
  onSaved,
}: {
  channel?: DistributionChannel;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!channel;
  const [name, setName] = useState(channel?.name ?? "");
  const [key, setKey] = useState(channel?.key ?? "");
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState(channel?.description ?? "");
  const [category, setCategory] = useState(channel?.category ?? "");
  const [status, setStatus] = useState<"live" | "soon">(
    channel?.status ?? "soon",
  );
  const [outlet, setOutlet] = useState<
    "" | "newsletter" | "matt" | "parentdata"
  >(channel?.outlet ?? "");
  const [href, setHref] = useState(channel?.href ?? "");
  const [isPrimary, setIsPrimary] = useState(channel?.isPrimary ?? false);
  const [sortOrder, setSortOrder] = useState(
    channel ? String(channel.sortOrder) : "",
  );
  const [msg, setMsg] = useState<string | null>(null);

  function slugify(v: string): string {
    return v
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  const save = useMutation({
    mutationFn: () => {
      const trimmedHref = href.trim();
      const body = {
        name: name.trim(),
        description: description.trim(),
        category: category.trim(),
        status,
        outlet: outlet || null,
        href: trimmedHref || null,
        isPrimary,
        ...(sortOrder.trim() !== "" ? { sortOrder: Number(sortOrder) } : {}),
        ...(isEdit ? {} : { key: key.trim() }),
      };
      return fetchJson(
        isEdit
          ? `/api/faculty/admin/distribution-channels/${channel!.id}`
          : "/api/faculty/admin/distribution-channels",
        {
          method: isEdit ? "PATCH" : "POST",
          body: JSON.stringify(body),
        },
      );
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (e) => setMsg((e as Error).message),
  });

  const keyValid = isEdit || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key.trim());
  // Mirrors the server's refine: a live card with neither a destination nor a
  // link would render blank. "Soon" cards are fine with neither.
  const hasDestination = !!outlet || href.trim().length > 0;
  const liveOk = status !== "live" || hasDestination;
  const canSave =
    name.trim().length > 0 && keyValid && liveOk && !save.isPending;

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
      data-testid="dialog-channel-form"
    >
      <div
        className="bg-[#FBF7F0] border border-[#E8DDD0] rounded-2xl w-full max-w-md p-6 shadow-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <h2 className="font-serif text-2xl">
            {isEdit ? "Edit channel" : "New channel"}
          </h2>
          <button
            onClick={onClose}
            className="text-[#8a6a5a] hover:text-[#572020] text-xl leading-none"
            data-testid="button-close-channel"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <label className="block text-[11px] tracking-[0.15em] uppercase text-[#8a6a5a] mb-1">
          Name
        </label>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setMsg(null);
            if (!isEdit && !keyTouched) setKey(slugify(e.target.value));
          }}
          className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 mb-3 bg-white focus:border-[#8C1515] outline-none"
          data-testid="input-channel-name"
          placeholder="e.g. The New York Times"
        />

        <label className="block text-[11px] tracking-[0.15em] uppercase text-[#8a6a5a] mb-1">
          Key
        </label>
        {isEdit ? (
          <p
            className="text-sm font-mono text-[#8a6a5a] mb-3"
            data-testid="text-channel-key-readonly"
          >
            {channel!.key}{" "}
            <span className="text-xs not-italic font-sans">
              (immutable — anchors interest signals)
            </span>
          </p>
        ) : (
          <>
            <input
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setKeyTouched(true);
                setMsg(null);
              }}
              className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 mb-1 bg-white focus:border-[#8C1515] outline-none font-mono text-sm"
              data-testid="input-channel-key"
              placeholder="the-new-york-times"
            />
            <p className="text-xs text-[#8a6a5a] mb-3">
              Lowercase letters, numbers and hyphens. Can’t be changed later.
            </p>
          </>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] tracking-[0.15em] uppercase text-[#8a6a5a] mb-1">
              Category
            </label>
            <input
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setMsg(null);
              }}
              className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 mb-3 bg-white focus:border-[#8C1515] outline-none text-sm"
              data-testid="input-channel-category"
              placeholder="News outlet"
            />
          </div>
          <div>
            <label className="block text-[11px] tracking-[0.15em] uppercase text-[#8a6a5a] mb-1">
              Status
            </label>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as "live" | "soon");
                setMsg(null);
              }}
              className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 mb-3 bg-white focus:border-[#8C1515] outline-none text-sm"
              data-testid="select-channel-status"
            >
              <option value="live">Live</option>
              <option value="soon">Soon</option>
            </select>
          </div>
        </div>

        <label className="block text-[11px] tracking-[0.15em] uppercase text-[#8a6a5a] mb-1">
          Description
        </label>
        <textarea
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            setMsg(null);
          }}
          rows={3}
          className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 mb-4 bg-white focus:border-[#8C1515] outline-none text-sm"
          data-testid="input-channel-description"
          placeholder="What lands on this channel and why it matters"
        />

        <label className="block text-[11px] tracking-[0.15em] uppercase text-[#8a6a5a] mb-1">
          Built-in destination
        </label>
        <select
          value={outlet}
          onChange={(e) => {
            setOutlet(
              e.target.value as "" | "newsletter" | "matt" | "parentdata",
            );
            setMsg(null);
          }}
          className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 mb-1 bg-white focus:border-[#8C1515] outline-none text-sm"
          data-testid="select-channel-outlet"
        >
          <option value="">None (link out or notify-me)</option>
          <option value="newsletter">Newsletter</option>
          <option value="parentdata">ParentData</option>
          <option value="matt">Offer to Matt</option>
        </select>
        <p className="text-xs text-[#8a6a5a] mb-3">
          A built-in destination opens its own in-app view. Leave as None to use
          an external link, or a notify-me card.
        </p>

        <label className="block text-[11px] tracking-[0.15em] uppercase text-[#8a6a5a] mb-1">
          External link
        </label>
        <input
          value={href}
          onChange={(e) => {
            setHref(e.target.value);
            setMsg(null);
          }}
          disabled={!!outlet}
          className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 mb-1 bg-white focus:border-[#8C1515] outline-none text-sm disabled:bg-[#F4EEE6] disabled:text-[#a08c7c]"
          data-testid="input-channel-href"
          placeholder="https://example.com"
        />
        <p className="text-xs text-[#8a6a5a] mb-3">
          {outlet
            ? "Ignored while a built-in destination is selected."
            : "Full https:// URL. Leave blank for a notify-me “Soon” card."}
        </p>

        <div className="flex items-center gap-4 mb-4">
          <label
            className="flex items-center gap-2 text-sm text-[#572020]"
            data-testid="label-channel-primary"
          >
            <input
              type="checkbox"
              checked={isPrimary}
              onChange={(e) => setIsPrimary(e.target.checked)}
              className="accent-[#8C1515]"
              data-testid="checkbox-channel-primary"
            />
            Primary (highlighted)
          </label>
          <div className="flex items-center gap-2">
            <label className="text-[11px] tracking-[0.15em] uppercase text-[#8a6a5a]">
              Order
            </label>
            <input
              value={sortOrder}
              onChange={(e) =>
                setSortOrder(e.target.value.replace(/[^0-9]/g, ""))
              }
              inputMode="numeric"
              className="w-20 border border-[#E8DDD0] rounded-lg px-2 py-1.5 bg-white focus:border-[#8C1515] outline-none text-sm"
              data-testid="input-channel-sortorder"
              placeholder="auto"
            />
          </div>
        </div>

        {status === "live" && !hasDestination && (
          <p className="text-xs text-[#8a6a5a] mb-3">
            A live channel needs a built-in destination or an external link.
          </p>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={() => save.mutate()}
            disabled={!canSave}
            className="bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition disabled:opacity-40"
            data-testid="button-save-channel"
          >
            {save.isPending
              ? "Saving…"
              : isEdit
                ? "Save changes"
                : "Create channel"}
          </button>
          {msg && (
            <span
              className="text-xs text-[#E8352A]"
              data-testid="text-channel-error"
            >
              {msg}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Delete a distribution channel after a confirmation prompt. */
function ChannelDeleteButton({ channel }: { channel: DistributionChannel }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const del = useMutation({
    mutationFn: () =>
      fetchJson(`/api/faculty/admin/distribution-channels/${channel.id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      setConfirm(false);
      qc.invalidateQueries({
        queryKey: ["faculty-admin-distribution-channels"],
      });
      qc.invalidateQueries({ queryKey: ["faculty-distribution-channels"] });
    },
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirm(true)}
        disabled={del.isPending}
        className="text-xs text-[#E8352A] hover:underline disabled:opacity-40 ml-auto"
        data-testid={`button-delete-channel-${channel.id}`}
      >
        Delete
      </button>
      {confirm && (
        <div
          className="fixed inset-0 z-[210] bg-black/40 flex items-center justify-center p-4"
          onClick={() => setConfirm(false)}
          data-testid={`dialog-delete-channel-${channel.id}`}
        >
          <div
            className="bg-[#FBF7F0] border border-[#E8DDD0] rounded-2xl w-full max-w-md p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-serif text-2xl mb-2">
              Delete “{channel.name}”?
            </h2>
            <p className="text-sm text-[#8a6a5a] mb-5">
              This removes the card from every steward’s Distribution Channels
              page. Any “notify me” signals stewards left for it are kept but
              will no longer show a label. This can’t be undone.
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={() => del.mutate()}
                disabled={del.isPending}
                className="bg-[#E8352A] text-white px-4 py-2 rounded-lg text-sm font-medium hover:brightness-95 transition disabled:opacity-40"
                data-testid={`button-confirm-delete-channel-${channel.id}`}
              >
                {del.isPending ? "Deleting…" : "Delete permanently"}
              </button>
              <button
                onClick={() => setConfirm(false)}
                className="text-[#572020] underline hover:no-underline text-sm"
                data-testid={`button-cancel-delete-channel-${channel.id}`}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const ALL_ROLES = ["steward", "contributor", "advisor", "viewer"] as const;

/**
 * Calls a mutating faculty-admin endpoint and transparently handles the
 * 409 + `requiresConfirmation` guardrail (e.g. removing the last steward of an
 * active pillar): on a confirmation response it asks the admin, then retries
 * with `?force=true`. All requests go through `fetchJson`, so the read-only
 * "Preview as member" guard still blocks them.
 */
type ConfirmOptions = {
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

/**
 * Branded in-app confirmation modal. Replaces `window.confirm` for the
 * consequential access-removal actions so the prompt matches the cardinal/cream
 * faculty portal instead of an unstyled native pop-up. Clicking the backdrop or
 * Cancel resolves as a decline; only the accept button confirms.
 */
function ConfirmDialog({
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
}: {
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[210] bg-black/40 flex items-center justify-center p-4"
      onClick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
      data-testid="dialog-confirm"
    >
      <div
        className="bg-[#FBF7F0] border border-[#E8DDD0] rounded-2xl w-full max-w-sm p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p
          className="text-sm text-[#572020] whitespace-pre-line mb-5"
          data-testid="text-confirm-message"
        >
          {message}
        </p>
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="text-[#8a6a5a] hover:text-[#572020] text-sm px-4 py-2"
            data-testid="button-confirm-cancel"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            autoFocus
            className={
              danger
                ? "border border-[#E8352A] text-[#E8352A] px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#E8352A] hover:text-white transition"
                : "bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition"
            }
            data-testid="button-confirm-accept"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

async function callWithConfirm<T>(
  confirm: (opts: ConfirmOptions) => Promise<boolean>,
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) init.body = JSON.stringify(body);
  try {
    return await fetchJson<T>(path, init);
  } catch (e) {
    let parsed: {
      requiresConfirmation?: boolean;
      error?: string;
      pillarName?: string;
      pillarNames?: string[];
    } | null = null;
    try {
      parsed = JSON.parse((e as Error).message);
    } catch {
      parsed = null;
    }
    if (!parsed?.requiresConfirmation) throw e;
    const ok = await confirm({
      message: `${parsed.error ?? "This action needs confirmation."}\n\nProceed anyway?`,
      confirmLabel: "Proceed",
      danger: true,
    });
    if (!ok) throw new Error("Cancelled");
    const sep = path.includes("?") ? "&" : "?";
    return await fetchJson<T>(`${path}${sep}force=true`, init);
  }
}

function EditMemberDialog({
  member,
  pillars,
  isSelf,
  onClose,
  onSaved,
}: {
  member: AdminMember;
  pillars: AdminPillar[];
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fullName, setFullName] = useState(member.fullName ?? "");
  const [institution, setInstitution] = useState(member.institution ?? "");
  const [photoUrl, setPhotoUrl] = useState(member.photoUrl ?? null);
  const [password, setPassword] = useState("");
  const [nameMsg, setNameMsg] = useState<string | null>(null);
  const [photoMsg, setPhotoMsg] = useState<string | null>(null);
  const [pwMsg, setPwMsg] = useState<string | null>(null);

  // Membership management is local-state-first: the parent holds a snapshot of
  // `member` in its `editing` state, so we mirror memberships/deactivation here
  // and update them optimistically on success (parent refetch still fires via
  // onSaved). Keyed by pillarId.
  const [memberships, setMemberships] = useState(member.memberships);
  const [deactivated, setDeactivated] = useState(member.deactivatedAt != null);
  const [archived, setArchived] = useState(member.archivedAt != null);
  const [memberMsg, setMemberMsg] = useState<string | null>(null);
  // Set when a remove/reactivate succeeded locally but the Clerk ban/unban
  // call failed — the admin must see this, not just a server log.
  const [clerkWarning, setClerkWarning] = useState<string | null>(null);
  const [addPillarId, setAddPillarId] = useState<number | "">("");
  const [addRole, setAddRole] = useState<(typeof ALL_ROLES)[number]>("steward");

  const heldPillarIds = new Set(memberships.map((m) => m.pillarId));
  const addablePillars = pillars.filter(
    (p) => p.retiredAt == null && !heldPillarIds.has(p.id),
  );

  // Promise-based in-app confirm: a button/helper awaits `confirm(opts)`, which
  // renders <ConfirmDialog> and resolves true/false when the admin chooses.
  const [confirmReq, setConfirmReq] = useState<
    (ConfirmOptions & { resolve: (ok: boolean) => void }) | null
  >(null);
  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setConfirmReq({ ...opts, resolve })),
    [],
  );

  const changeRole = useMutation({
    mutationFn: (vars: { pillarId: number; role: string }) =>
      callWithConfirm(
        confirm,
        `/api/faculty/admin/members/${member.id}/memberships/${vars.pillarId}`,
        "PATCH",
        { role: vars.role },
      ),
    onSuccess: (_d, vars) => {
      setMemberships((cur) =>
        cur.map((m) =>
          m.pillarId === vars.pillarId ? { ...m, role: vars.role } : m,
        ),
      );
      setMemberMsg("Role updated.");
      onSaved();
    },
    onError: (e) => setMemberMsg((e as Error).message),
  });

  const removeMembership = useMutation({
    mutationFn: (pillarId: number) =>
      callWithConfirm(
        confirm,
        `/api/faculty/admin/members/${member.id}/memberships/${pillarId}`,
        "DELETE",
      ),
    onSuccess: (_d, pillarId) => {
      setMemberships((cur) => cur.filter((m) => m.pillarId !== pillarId));
      setMemberMsg("Removed from pillar. Their content stays live.");
      onSaved();
    },
    onError: (e) => setMemberMsg((e as Error).message),
  });

  const addMembership = useMutation({
    mutationFn: (vars: { pillarId: number; role: string }) =>
      callWithConfirm(
        confirm,
        `/api/faculty/admin/members/${member.id}/memberships`,
        "POST",
        vars,
      ),
    onSuccess: (_d, vars) => {
      const p = pillars.find((pp) => pp.id === vars.pillarId);
      if (p) {
        setMemberships((cur) => [
          ...cur,
          {
            pillarId: p.id,
            pillarSlug: p.slug,
            pillarName: p.name,
            role: vars.role,
          },
        ]);
      }
      setAddPillarId("");
      setAddRole("steward");
      setMemberMsg("Added to pillar.");
      onSaved();
    },
    onError: (e) => setMemberMsg((e as Error).message),
  });

  const deactivate = useMutation({
    mutationFn: () =>
      callWithConfirm(
        confirm,
        `/api/faculty/admin/members/${member.id}/deactivate`,
        "POST",
      ),
    onSuccess: (d) => {
      setDeactivated(true);
      setMemberships([]);
      const warning = (d as { clerkWarning?: string } | undefined)
        ?.clerkWarning;
      setClerkWarning(warning ?? null);
      setMemberMsg(
        "Member removed. Sign-in disabled; authored content stays live.",
      );
      onSaved();
    },
    onError: (e) => setMemberMsg((e as Error).message),
  });

  const reactivate = useMutation({
    mutationFn: () =>
      callWithConfirm(
        confirm,
        `/api/faculty/admin/members/${member.id}/reactivate`,
        "POST",
      ),
    onSuccess: (d) => {
      setDeactivated(false);
      const warning = (d as { clerkWarning?: string } | undefined)
        ?.clerkWarning;
      setClerkWarning(warning ?? null);
      setMemberMsg("Member reactivated. Re-add pillars as needed.");
      onSaved();
    },
    onError: (e) => setMemberMsg((e as Error).message),
  });

  const archive = useMutation({
    mutationFn: () =>
      callWithConfirm(
        confirm,
        `/api/faculty/admin/members/${member.id}/archive`,
        "POST",
      ),
    onSuccess: () => {
      setArchived(true);
      setMemberMsg(
        "Account archived. Custodian added as co-steward; member sees an on-leave screen.",
      );
      onSaved();
    },
    onError: (e) => setMemberMsg((e as Error).message),
  });

  const restore = useMutation({
    mutationFn: () =>
      callWithConfirm(
        confirm,
        `/api/faculty/admin/members/${member.id}/restore`,
        "POST",
      ),
    onSuccess: () => {
      setArchived(false);
      setMemberMsg("Account restored. Portal access is live again.");
      onSaved();
    },
    onError: (e) => setMemberMsg((e as Error).message),
  });

  const saveName = useMutation({
    mutationFn: () =>
      fetchJson(`/api/faculty/admin/members/${member.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          fullName: fullName.trim(),
          institution: institution.trim(),
        }),
      }),
    onSuccess: () => {
      setNameMsg("Saved.");
      onSaved();
    },
    onError: (e) => setNameMsg((e as Error).message),
  });

  const savePhoto = useMutation({
    mutationFn: (next: string | null) =>
      fetchJson(`/api/faculty/admin/members/${member.id}`, {
        method: "PATCH",
        body: JSON.stringify({ photoUrl: next ?? "" }),
      }),
    onSuccess: (_data, next) => {
      setPhotoUrl(next);
      setPhotoMsg("Saved.");
      onSaved();
    },
    onError: (e) => setPhotoMsg((e as Error).message),
  });

  const resetPassword = useMutation({
    mutationFn: () =>
      fetchJson(`/api/faculty/admin/members/${member.id}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ password }),
      }),
    onSuccess: () => {
      setPwMsg("Password updated. Share it with the member securely.");
      setPassword("");
    },
    onError: (e) => setPwMsg((e as Error).message),
  });

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
      data-testid="dialog-edit-member"
    >
      <div
        className="bg-[#FBF7F0] border border-[#E8DDD0] rounded-2xl w-full max-w-md p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-1">
          <h2 className="font-serif text-2xl">Edit member</h2>
          <button
            onClick={onClose}
            className="text-[#8a6a5a] hover:text-[#572020] text-xl leading-none"
            data-testid="button-close-edit"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <p className="text-sm text-[#8a6a5a] mb-5">{member.email}</p>

        <label className="block text-[11px] tracking-[0.15em] uppercase text-[#8a6a5a] mb-2">
          Headshot
        </label>
        <div className="mb-2">
          <HeadshotField
            name={fullName.trim() || member.fullName}
            photoUrl={photoUrl}
            saving={savePhoto.isPending}
            onChange={(next) => {
              setPhotoMsg(null);
              savePhoto.mutate(next);
            }}
          />
        </div>
        {photoMsg && (
          <p
            className="text-xs text-[#8a6a5a] mb-4"
            data-testid="text-photo-msg"
          >
            {photoMsg}
          </p>
        )}

        <label className="block text-[11px] tracking-[0.15em] uppercase text-[#8a6a5a] mb-1">
          Full name
        </label>
        <input
          value={fullName}
          onChange={(e) => {
            setFullName(e.target.value);
            setNameMsg(null);
          }}
          className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 mb-4 bg-white focus:border-[#8C1515] outline-none"
          data-testid="input-fullname"
        />

        <label className="block text-[11px] tracking-[0.15em] uppercase text-[#8a6a5a] mb-1">
          Institution
        </label>
        <p className="text-xs text-[#8a6a5a] mb-2">
          Affiliation shown as a “from [Institution]” byline credit. Leave blank
          for a name-only byline.
        </p>
        <input
          value={institution}
          onChange={(e) => {
            setInstitution(e.target.value);
            setNameMsg(null);
          }}
          placeholder="e.g. Stanford Medicine"
          className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 mb-2 bg-white focus:border-[#8C1515] outline-none"
          data-testid="input-institution"
        />
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => saveName.mutate()}
            disabled={
              saveName.isPending ||
              fullName.trim().length === 0 ||
              (fullName.trim() === (member.fullName ?? "") &&
                institution.trim() === (member.institution ?? ""))
            }
            className="bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition disabled:opacity-40"
            data-testid="button-save-name"
          >
            {saveName.isPending ? "Saving…" : "Save"}
          </button>
          {nameMsg && (
            <span
              className="text-xs text-[#8a6a5a]"
              data-testid="text-name-msg"
            >
              {nameMsg}
            </span>
          )}
        </div>

        <div className="border-t border-[#E8DDD0] pt-5">
          <label className="block text-[11px] tracking-[0.15em] uppercase text-[#8a6a5a] mb-1">
            Reset password
          </label>
          <p className="text-xs text-[#8a6a5a] mb-2">
            Set a new password (min 8 characters), then share it with the member
            securely. They can change it after signing in.
          </p>
          <input
            type="text"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setPwMsg(null);
            }}
            placeholder="New password"
            autoComplete="off"
            className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 mb-2 bg-white focus:border-[#8C1515] outline-none"
            data-testid="input-password"
          />
          <div className="flex items-center gap-3">
            <button
              onClick={() => resetPassword.mutate()}
              disabled={resetPassword.isPending || password.length < 8}
              className="border border-[#8C1515] text-[#8C1515] px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#8C1515] hover:text-white transition disabled:opacity-40"
              data-testid="button-reset-password"
            >
              {resetPassword.isPending ? "Updating…" : "Set new password"}
            </button>
            {pwMsg && (
              <span
                className="text-xs text-[#8a6a5a]"
                data-testid="text-pw-msg"
              >
                {pwMsg}
              </span>
            )}
          </div>
        </div>

        <div className="border-t border-[#E8DDD0] pt-5 mt-5">
          <label className="block text-[11px] tracking-[0.15em] uppercase text-[#8a6a5a] mb-1">
            Pillars &amp; roles
          </label>
          {deactivated ? (
            <p
              className="text-xs text-[#8C1515] mb-3"
              data-testid="text-deactivated-notice"
            >
              This member is deactivated — sign-in is disabled and they hold no
              pillars. Their authored content stays live. Reactivate to restore
              access, then re-add pillars.
            </p>
          ) : (
            <>
              <p className="text-xs text-[#8a6a5a] mb-3">
                Change a role, remove from a pillar, or add to a pillar.
                Removing access never deletes their published sources or
                interpretations.
              </p>
              <div className="space-y-2 mb-4">
                {memberships.length === 0 && (
                  <p className="text-xs text-[#8a6a5a]">No pillars yet.</p>
                )}
                {memberships.map((mm) => (
                  <div
                    key={mm.pillarId}
                    className="flex items-center gap-2"
                    data-testid={`membership-row-${mm.pillarId}`}
                  >
                    <span className="text-sm text-[#572020] flex-1 truncate">
                      {mm.pillarName}
                    </span>
                    <select
                      value={mm.role}
                      disabled={changeRole.isPending}
                      onChange={(e) => {
                        setMemberMsg(null);
                        changeRole.mutate({
                          pillarId: mm.pillarId,
                          role: e.target.value,
                        });
                      }}
                      className="border border-[#E8DDD0] rounded-lg px-2 py-1 text-sm bg-white focus:border-[#8C1515] outline-none"
                      data-testid={`select-role-${mm.pillarId}`}
                    >
                      {ALL_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={async () => {
                        setMemberMsg(null);
                        const ok = await confirm({
                          message: `Remove ${member.fullName ?? member.email} from ${mm.pillarName}? They lose access to this pillar but keep their other pillars; their authored content stays live.`,
                          confirmLabel: "Remove",
                          danger: true,
                        });
                        if (!ok) return;
                        removeMembership.mutate(mm.pillarId);
                      }}
                      disabled={removeMembership.isPending}
                      className="text-[#8C1515] hover:text-[#a01a1a] text-sm px-2 py-1 disabled:opacity-40"
                      data-testid={`button-remove-membership-${mm.pillarId}`}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>

              {addablePillars.length > 0 && (
                <div className="flex items-center gap-2 mb-2">
                  <select
                    value={addPillarId}
                    onChange={(e) =>
                      setAddPillarId(
                        e.target.value ? Number(e.target.value) : "",
                      )
                    }
                    className="border border-[#E8DDD0] rounded-lg px-2 py-1 text-sm bg-white focus:border-[#8C1515] outline-none flex-1"
                    data-testid="select-add-pillar"
                  >
                    <option value="">Add to a pillar…</option>
                    {addablePillars.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={addRole}
                    onChange={(e) =>
                      setAddRole(e.target.value as (typeof ALL_ROLES)[number])
                    }
                    className="border border-[#E8DDD0] rounded-lg px-2 py-1 text-sm bg-white focus:border-[#8C1515] outline-none"
                    data-testid="select-add-role"
                  >
                    {ALL_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => {
                      if (addPillarId === "") return;
                      setMemberMsg(null);
                      addMembership.mutate({
                        pillarId: addPillarId,
                        role: addRole,
                      });
                    }}
                    disabled={addPillarId === "" || addMembership.isPending}
                    className="bg-[#8C1515] text-white px-3 py-1 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition disabled:opacity-40"
                    data-testid="button-add-membership"
                  >
                    Add
                  </button>
                </div>
              )}
            </>
          )}
          {memberMsg && (
            <p
              className="text-xs text-[#8a6a5a] mt-1"
              data-testid="text-member-msg"
            >
              {memberMsg}
            </p>
          )}
        </div>

        {!isSelf && !deactivated && (
          <div className="border-t border-[#E8DDD0] pt-5 mt-5">
            <label className="block text-[11px] tracking-[0.15em] uppercase text-[#8a6a5a] mb-1">
              {archived ? "Restore account" : "Archive (on leave)"}
            </label>
            {archived ? (
              <>
                <p className="text-xs text-[#8a6a5a] mb-2">
                  Restore portal access. Custodian co-steward memberships are
                  left in place — remove them via Pillars &amp; roles above if
                  no longer needed.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setMemberMsg(null);
                    restore.mutate();
                  }}
                  disabled={restore.isPending}
                  className="border border-[#8C1515] text-[#8C1515] px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#8C1515] hover:text-white transition disabled:opacity-40"
                  data-testid="button-restore-member"
                >
                  {restore.isPending ? "Restoring…" : "Restore"}
                </button>
              </>
            ) : (
              <>
                <p className="text-xs text-[#8a6a5a] mb-2">
                  Suspends the portal with an "on leave" screen. Clerk sign-in
                  stays active; memberships are preserved; custodian is
                  auto-added as co-steward. Fully reversible.
                </p>
                <button
                  type="button"
                  onClick={async () => {
                    setMemberMsg(null);
                    const ok = await confirm({
                      message: `Archive ${member.fullName ?? member.email}? Their portal shows an "on leave" screen. Clerk access stays active; memberships preserved; custodian will be added as co-steward on their steward pillars.`,
                      confirmLabel: "Archive",
                      danger: false,
                    });
                    if (!ok) return;
                    archive.mutate();
                  }}
                  disabled={archive.isPending}
                  className="border border-[#572020] text-[#572020] px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#572020] hover:text-white transition disabled:opacity-40"
                  data-testid="button-archive-member"
                >
                  {archive.isPending ? "Archiving…" : "Archive (on leave)"}
                </button>
              </>
            )}
          </div>
        )}

        {!isSelf && (
          <div className="border-t border-[#E8DDD0] pt-5 mt-5">
            <label className="block text-[11px] tracking-[0.15em] uppercase text-[#8a6a5a] mb-1">
              {deactivated ? "Reactivate member" : "Remove member"}
            </label>
            {deactivated ? (
              <>
                <p className="text-xs text-[#8a6a5a] mb-2">
                  Restore portal sign-in. Pillars are not re-added
                  automatically.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setClerkWarning(null);
                    reactivate.mutate();
                  }}
                  disabled={reactivate.isPending}
                  className="border border-[#8C1515] text-[#8C1515] px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#8C1515] hover:text-white transition disabled:opacity-40"
                  data-testid="button-reactivate-member"
                >
                  {reactivate.isPending ? "Reactivating…" : "Reactivate"}
                </button>
              </>
            ) : (
              <>
                <p className="text-xs text-[#8a6a5a] mb-2">
                  Revokes all pillar access and disables portal sign-in. Their
                  authored sources, interpretations, and voice stay live in the
                  pillars. This is reversible (reactivate later).
                </p>
                <button
                  type="button"
                  onClick={async () => {
                    setMemberMsg(null);
                    const ok = await confirm({
                      message: `Remove ${member.fullName ?? member.email}? They lose all pillar access and can no longer sign in. Authored content stays live.`,
                      confirmLabel: "Remove member",
                      danger: true,
                    });
                    if (!ok) return;
                    setClerkWarning(null);
                    deactivate.mutate();
                  }}
                  disabled={deactivate.isPending}
                  className="border border-[#E8352A] text-[#E8352A] px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#E8352A] hover:text-white transition disabled:opacity-40"
                  data-testid="button-deactivate-member"
                >
                  {deactivate.isPending ? "Removing…" : "Remove member"}
                </button>
              </>
            )}
            {clerkWarning && (
              <div
                className="mt-3 border border-[#E8352A] bg-[#FDEDEC] rounded-lg px-3 py-2 text-xs text-[#8C1515] leading-relaxed"
                data-testid="warning-clerk-call-failed"
              >
                <strong>Heads up:</strong> {clerkWarning}
              </div>
            )}
          </div>
        )}
        {confirmReq && (
          <ConfirmDialog
            message={confirmReq.message}
            confirmLabel={confirmReq.confirmLabel}
            cancelLabel={confirmReq.cancelLabel}
            danger={confirmReq.danger}
            onConfirm={() => {
              confirmReq.resolve(true);
              setConfirmReq(null);
            }}
            onCancel={() => {
              confirmReq.resolve(false);
              setConfirmReq(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

type NonStewardRole = "contributor" | "advisor" | "viewer";

// A faculty member can hold different roles across pillars. For the first-run
// experience we lead with their most capable non-steward role so the copy never
// promises less than they can actually do.
function pickNonStewardRole(
  memberships: Array<{ role: string }>,
): NonStewardRole | null {
  const roles = new Set(memberships.map((m) => m.role));
  if (roles.has("contributor")) return "contributor";
  if (roles.has("advisor")) return "advisor";
  if (roles.has("viewer")) return "viewer";
  return null;
}

function NonStewardWelcomeCard({
  firstName,
  role,
}: {
  firstName: string | null;
  role: NonStewardRole;
}) {
  // Dismissible first-run orientation for contributors/advisors/viewers, the
  // non-steward parallel to StewardWelcomeCard. Persists per-browser via
  // localStorage so dismissing on one device doesn't re-show on another.
  const KEY = "palonur.faculty.nonStewardWelcomeDismissed.v1";
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      return window.localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  });
  const [open, setOpen] = useState(false);
  const stepsId = useId();
  if (dismissed) return null;

  const intro: Record<NonStewardRole, React.ReactNode> = {
    contributor: (
      <>
        You're a <strong>contributor</strong> — you can add sources and draft
        answers. A steward in your pillar gives the final sign-off before
        anything goes live.
      </>
    ),
    advisor: (
      <>
        You're an <strong>advisor</strong> — you bring a cross-pillar lens: add
        sources, draft answers, and weigh in on the work. A steward publishes
        the final answer.
      </>
    ),
    viewer: (
      <>
        You have <strong>view access</strong> — follow along with everything
        stewards publish across your pillars.
      </>
    ),
  };

  const stepsByRole: Record<
    NonStewardRole,
    Array<{ title: string; icon: React.ReactNode; body: React.ReactNode }>
  > = {
    contributor: [
      {
        title: "Your pillars",
        icon: <IconCompass />,
        body: (
          <>
            the Stanford domains you contribute to. Open one to see its library
            and drafts.
          </>
        ),
      },
      {
        title: "Add a source",
        icon: <IconBook />,
        body: (
          <>
            upload a paper, article, or note worth standing behind to a pillar's
            library.
          </>
        ),
      },
      {
        title: "Draft an answer",
        icon: <IconEdit />,
        body: (
          <>
            write the plain-language takeaway; your steward reviews it, then{" "}
            <em>approves</em> to make it live on palonur.com and the agent.
          </>
        ),
      },
      {
        title: "The newsletter",
        icon: <IconInbox />,
        body: (
          <>
            offer a post to the Stanford Lifestyle Medicine newsletter and get
            credited.
          </>
        ),
      },
      {
        title: "Who publishes",
        icon: <IconUsers />,
        body: (
          <>
            only stewards approve — your sources and drafts go to them for the
            final sign-off.
          </>
        ),
      },
    ],
    advisor: [
      {
        title: "Your pillars",
        icon: <IconCompass />,
        body: (
          <>
            the domains you advise on. Open one to see its library and drafts.
          </>
        ),
      },
      {
        title: "Add & draft",
        icon: <IconEdit />,
        body: (
          <>
            you can add sources and draft answers across your pillars, bringing
            your cross-pillar lens.
          </>
        ),
      },
      {
        title: "Explore",
        icon: <IconBook />,
        body: (
          <>
            browse what stewards across Stanford have published and weigh in on
            the work.
          </>
        ),
      },
      {
        title: "The newsletter",
        icon: <IconInbox />,
        body: (
          <>
            offer a post to the Stanford Lifestyle Medicine newsletter and get
            credited.
          </>
        ),
      },
      {
        title: "Who publishes",
        icon: <IconUsers />,
        body: (
          <>
            stewards give the final sign-off — your input shapes the answer
            before it goes live.
          </>
        ),
      },
    ],
    viewer: [
      {
        title: "Your pillars",
        icon: <IconCompass />,
        body: <>the Stanford domains you can follow.</>,
      },
      {
        title: "Library",
        icon: <IconBook />,
        body: (
          <>
            read the answers stewards have approved — exactly what readers see
            today on palonur.com.
          </>
        ),
      },
      {
        title: "Explore",
        icon: <IconCompass />,
        body: <>browse everything published across Stanford pillars.</>,
      },
      {
        title: "The newsletter",
        icon: <IconInbox />,
        body: <>see what's being shared with readers.</>,
      },
    ],
  };

  const steps = stepsByRole[role];

  return (
    <section
      className="mb-8 border border-[#E8DDD0] rounded-xl p-6 bg-white/60 relative"
      data-testid="card-nonsteward-welcome"
    >
      <button
        type="button"
        onClick={() => {
          try {
            window.localStorage.setItem(KEY, "1");
          } catch {
            /* swallow private-mode storage errors */
          }
          setDismissed(true);
        }}
        className="absolute top-4 right-4 text-[#8a6a5a] hover:text-[#572020] text-xs"
        aria-label="Dismiss"
        data-testid="button-dismiss-nonsteward-welcome"
      >
        Got it ×
      </button>
      <div className="flex items-start gap-4">
        <div className="flex-none hidden sm:inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-[#F9F5EE] to-[#F4ECDD] border border-[#E8DDD0]">
          <img
            src={illu("chapter-keys")}
            alt=""
            aria-hidden
            loading="lazy"
            className="h-11 w-11 object-contain"
          />
        </div>
        <div>
          <SectionEyebrow icon={<IconBook />} label="How the portal works" />
          <h2 className="font-serif text-xl mb-1 text-[#572020]">
            Welcome{firstName ? `, ${firstName}` : ""}.
          </h2>
          <p className="text-sm text-[#8a6a5a] mb-4 max-w-2xl">{intro[role]}</p>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={stepsId}
            className="text-xs font-medium text-[#8C1515] hover:underline"
            data-testid="button-toggle-nonsteward-welcome-steps"
          >
            {open
              ? `Hide the ${steps.length} areas`
              : `Show the ${steps.length} areas →`}
          </button>
        </div>
      </div>
      {open && (
        <ol
          id={stepsId}
          className="mt-4 grid gap-3 sm:grid-cols-2"
          data-testid="nonsteward-welcome-steps"
        >
          {steps.map((s) => (
            <li
              key={s.title}
              className="flex gap-3 rounded-lg border border-[#E8DDD0] bg-[#FBF7F0] p-3"
            >
              <span
                className="flex-none inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[#8C1515]/8 text-[#8C1515]"
                aria-hidden
              >
                {s.icon}
              </span>
              <div className="text-sm text-[#572020]">
                <span className="font-medium">{s.title}</span> — {s.body}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function NonStewardStartHerePanel({
  role,
  firstSlug,
}: {
  role: NonStewardRole;
  firstSlug: string | null;
}) {
  // Non-steward parallel to the steward first-run hero: a warm, illustrated
  // "where to begin" list scoped to what a contributor/advisor/viewer can do.
  const libraryHref = firstSlug ? `/pillars/${firstSlug}/library` : null;

  const header: Record<NonStewardRole, { title: string; body: string }> = {
    contributor: {
      title: "Your path from first source to a credited post",
      body: "You can add sources, draft answers, and offer posts to the newsletter — a steward gives the final sign-off. Here's where to start.",
    },
    advisor: {
      title: "Where to begin as an advisor",
      body: "Explore what's published, add your cross-pillar lens, and offer posts. A steward publishes the final answer.",
    },
    viewer: {
      title: "Where to begin",
      body: "You have view access — here's what you can explore and follow across Stanford's pillars.",
    },
  };

  const stepsByRole: Record<
    NonStewardRole,
    Array<{ title: string; illustration: string; body: React.ReactNode }>
  > = {
    contributor: [
      {
        title: "Browse a pillar's library",
        illustration: "move-explore",
        body: (
          <>
            see the sources and approved answers in a pillar you contribute to.
            {libraryHref && (
              <>
                {" "}
                <Link
                  href={libraryHref}
                  className="text-[#8C1515] font-medium hover:underline"
                  data-testid="link-nonsteward-library"
                >
                  Open your library →
                </Link>
              </>
            )}
          </>
        ),
      },
      {
        title: "Add a source",
        illustration: "move-add",
        body: (
          <>
            upload a paper, article, or note worth standing behind.
            {libraryHref && (
              <>
                {" "}
                <Link
                  href={libraryHref}
                  className="text-[#8C1515] font-medium hover:underline"
                  data-testid="link-nonsteward-add-source"
                >
                  Add a source →
                </Link>
              </>
            )}
          </>
        ),
      },
      {
        title: "Draft an answer",
        illustration: "move-interpret",
        body: (
          <>
            write the plain-language takeaway a reader (and the AI) should walk
            away with. Your steward reviews and approves it to go live.
          </>
        ),
      },
      {
        title: "Offer it to the newsletter",
        illustration: "move-credit",
        body: (
          <>
            contribute a post to the Stanford Lifestyle Medicine newsletter and
            get credited.{" "}
            <Link
              href="/newsletter"
              className="text-[#8C1515] font-medium hover:underline"
              data-testid="link-nonsteward-newsletter"
            >
              Offer a post →
            </Link>
          </>
        ),
      },
      {
        title: "Explore other pillars",
        illustration: "move-explore",
        body: (
          <>
            see what stewards across Stanford have published.{" "}
            <Link
              href="/explore"
              className="text-[#8C1515] font-medium hover:underline"
              data-testid="link-nonsteward-explore"
            >
              Explore pillars →
            </Link>
          </>
        ),
      },
    ],
    advisor: [
      {
        title: "Explore what's published",
        illustration: "move-explore",
        body: (
          <>
            browse approved answers across every Stanford pillar.{" "}
            <Link
              href="/explore"
              className="text-[#8C1515] font-medium hover:underline"
              data-testid="link-nonsteward-explore"
            >
              Explore pillars →
            </Link>
          </>
        ),
      },
      {
        title: "Add & draft in your pillars",
        illustration: "move-interpret",
        body: (
          <>
            bring your cross-pillar lens — add sources and draft answers for a
            steward to review.
            {libraryHref && (
              <>
                {" "}
                <Link
                  href={libraryHref}
                  className="text-[#8C1515] font-medium hover:underline"
                  data-testid="link-nonsteward-library"
                >
                  Open your library →
                </Link>
              </>
            )}
          </>
        ),
      },
      {
        title: "Offer a post to the newsletter",
        illustration: "move-credit",
        body: (
          <>
            contribute to the Stanford Lifestyle Medicine newsletter and get
            credited.{" "}
            <Link
              href="/newsletter"
              className="text-[#8C1515] font-medium hover:underline"
              data-testid="link-nonsteward-newsletter"
            >
              Offer a post →
            </Link>
          </>
        ),
      },
      {
        title: "Weigh in on the work",
        illustration: "move-ready",
        body: (
          <>
            comment on drafts to help shape an answer before a steward publishes
            it.
          </>
        ),
      },
    ],
    viewer: [
      {
        title: "Explore what's published",
        illustration: "move-explore",
        body: (
          <>
            browse approved answers across every Stanford pillar.{" "}
            <Link
              href="/explore"
              className="text-[#8C1515] font-medium hover:underline"
              data-testid="link-nonsteward-explore"
            >
              Explore pillars →
            </Link>
          </>
        ),
      },
      {
        title: "Read your pillars' libraries",
        illustration: "move-ready",
        body: (
          <>
            the approved answers in your pillars — exactly what readers see on
            palonur.com.
            {libraryHref && (
              <>
                {" "}
                <Link
                  href={libraryHref}
                  className="text-[#8C1515] font-medium hover:underline"
                  data-testid="link-nonsteward-library"
                >
                  Open a library →
                </Link>
              </>
            )}
          </>
        ),
      },
      {
        title: "Follow the newsletter",
        illustration: "move-credit",
        body: (
          <>
            see what Stanford Lifestyle Medicine is sharing with readers.{" "}
            <Link
              href="/newsletter"
              className="text-[#8C1515] font-medium hover:underline"
              data-testid="link-nonsteward-newsletter"
            >
              View the newsletter →
            </Link>
          </>
        ),
      },
    ],
  };

  const steps = stepsByRole[role];
  const head = header[role];

  return (
    <section
      className="mb-8 border border-[#E8DDD0] border-l-4 border-l-[#8C1515] rounded-xl p-6 bg-[#F9F5EE]"
      data-testid="card-nonsteward-start-here"
    >
      <SectionEyebrow
        icon={<IconCompass />}
        label="Start here · get oriented"
        tone="cardinal"
      />
      <h2 className="font-serif text-xl mb-1 text-[#572020]">{head.title}</h2>
      <p className="text-sm text-[#8a6a5a] mb-5 max-w-2xl">{head.body}</p>
      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {steps.map((s, i) => (
          <li
            key={s.title}
            className="flex flex-col rounded-xl border border-[#E8DDD0] bg-white/60 p-4"
          >
            <div className="flex items-center gap-3 mb-2">
              <div className="flex-none inline-flex h-12 w-12 items-center justify-center rounded-xl bg-[#FBF7F0] border border-[#E8DDD0]">
                <img
                  src={illu(s.illustration)}
                  alt=""
                  aria-hidden
                  loading="lazy"
                  className="h-9 w-9 object-contain"
                />
              </div>
              <NumberBadge n={i + 1} />
            </div>
            <div className="text-sm text-[#572020]">
              <span className="font-medium">{s.title}</span> — {s.body}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// Shown on the dashboard for a platform admin / operator account that holds no
// pillar membership (e.g. karan@palonur.com, whose stray demo stewardships are
// revoked on sign-in). The steward-oriented "your pillar" card has no pillar to
// open for them, so instead point them straight at the admin surfaces they use.
function AdminHubPanel() {
  const cardClass =
    "group relative flex h-full flex-col rounded-2xl border border-[#E8DDD0] bg-white/50 p-7 text-left transition hover:border-[#8C1515] hover:bg-white/80 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8C1515] focus-visible:ring-offset-2";

  const Badge = ({ name }: { name: string }) => (
    <div className="mb-5 inline-flex h-20 w-20 items-center justify-center rounded-2xl border border-[#E8DDD0] bg-gradient-to-br from-[#F9F5EE] to-[#F4ECDD]">
      <img
        src={illu(name)}
        alt=""
        aria-hidden
        loading="eager"
        className="h-14 w-14 object-contain"
      />
    </div>
  );

  return (
    <section className="mb-12">
      <SectionEyebrow icon={<IconCompass />} label="Operator tools" />
      <h1 className="font-serif text-3xl font-medium mb-2">Run the platform</h1>
      <p className="text-[#8a6a5a] mb-8 max-w-2xl">
        You're signed in as a platform admin. This account doesn't steward a
        pillar — manage the stewards and pillars, or browse what each one
        governs.
      </p>
      <div className="grid gap-5 md:grid-cols-2">
        <Link
          href="/admin"
          className={cardClass}
          data-testid="card-admin-stewards"
        >
          <Badge name="chapter-trust" />
          <p className="text-[10px] tracking-[0.28em] text-[#8C1515] uppercase mb-2">
            Administration
          </p>
          <h2 className="font-serif text-2xl text-[#572020] mb-2">
            Stewards &amp; pillars
          </h2>
          <p className="text-[#7a5a4a] leading-relaxed mb-6">
            See every faculty steward, manage pillars, and preview any member's
            dashboard.
          </p>
          <span className="mt-auto inline-flex items-center gap-1.5 text-sm font-medium text-[#8C1515]">
            Open admin
            <span className="transition group-hover:translate-x-0.5">→</span>
          </span>
        </Link>
        <Link
          href="/explore"
          className={cardClass}
          data-testid="card-admin-explore"
        >
          <Badge name="chapter-gathering" />
          <p className="text-[10px] tracking-[0.28em] text-[#8C1515] uppercase mb-2">
            Browse
          </p>
          <h2 className="font-serif text-2xl text-[#572020] mb-2">
            Explore pillars
          </h2>
          <p className="text-[#7a5a4a] leading-relaxed mb-6">
            Browse every pillar and the knowledge each steward governs across
            the platform.
          </p>
          <span className="mt-auto inline-flex items-center gap-1.5 text-sm font-medium text-[#8C1515]">
            Explore pillars
            <span className="transition group-hover:translate-x-0.5">→</span>
          </span>
        </Link>
      </div>
    </section>
  );
}

// Platform admins need a cross-pillar source entry point even when their
// memberships only cover one or two working pillars. Keep this on the
// dashboard, where the admin starts, rather than making them discover the
// all-pillar list through a separate navigation item.
function AdminSourceManagerPanel() {
  const pillarsQuery = useQuery<{ pillars: AdminPillar[] }>({
    queryKey: ["faculty-admin-dashboard-pillars"],
    queryFn: () => fetchJson("/api/faculty/admin/pillars"),
  });
  const activePillars = (pillarsQuery.data?.pillars ?? []).filter(
    (pillar) => pillar.retiredAt == null,
  );

  return (
    <section
      className="mb-10 border border-[#E8DDD0] border-l-4 border-l-[#8C1515] bg-[#F9F5EE] p-6"
      data-testid="admin-source-manager-panel"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <SectionEyebrow icon={<IconCompass />} label="Admin proxy" />
          <h2 className="font-serif text-2xl font-medium text-[#572020]">
            Upload across all pillars
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#8a6a5a]">
            Add papers, Stanford Lifestyle Medicine articles, talks or
            transcripts, and notes to any active pillar. Uploads are attributed
            to your account and still require that pillar&apos;s steward review
            before they can support public answers.
          </p>
        </div>
        <Link
          href="/admin/data"
          className="inline-flex shrink-0 items-center justify-center border border-[#8C1515] px-4 py-2 text-sm font-medium text-[#8C1515] hover:bg-[#8C1515] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8C1515] focus-visible:ring-offset-2"
          data-testid="link-dashboard-pillar-data"
        >
          View pillar data
        </Link>
      </div>

      {pillarsQuery.isLoading ? (
        <p className="mt-5 text-sm text-[#8a6a5a]">Loading pillars…</p>
      ) : pillarsQuery.isError ? (
        <p className="mt-5 text-sm text-[#8C1515]">
          Couldn&apos;t load the pillar list. Open Pillar Data to try again.
        </p>
      ) : (
        <div
          className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="admin-dashboard-pillar-links"
        >
          {activePillars.map((pillar) => (
            <Link
              key={pillar.id}
              href={`/pillars/${pillar.slug}/library`}
              className="flex items-center justify-between gap-3 border border-[#E8DDD0] bg-white px-4 py-3 text-sm text-[#572020] hover:border-[#8C1515] hover:text-[#8C1515] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8C1515] focus-visible:ring-offset-2"
              data-testid={`link-dashboard-upload-${pillar.slug}`}
            >
              <span className="truncate">{pillar.name}</span>
              <span aria-hidden className="shrink-0">
                →
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function TwoPathsPanel({
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
}

// A small, domain-aware set of starter questions — used only when a brand-new
// pillar has no real reader demand (clusters/low-confidence) to seed from yet.
// Matched loosely against slug+name so it survives slug variations. Deliberately
// kept tiny; richer per-pillar lists are deferred.
const CURATED_STARTERS: Array<{ match: RegExp; q: string }> = [
  {
    match: /sleep|circad|insomnia/i,
    q: "How long does it actually take to fix a broken sleep schedule?",
  },
  {
    match: /nutri|diet|food|eating/i,
    q: "Is intermittent fasting really better for weight loss, or just easier to stick to?",
  },
  {
    match: /physical|activity|exercise|movement|fitness/i,
    q: "How much exercise do I actually need each week to lower my risk of disease?",
  },
  {
    match: /stress|mental|resilien|mind|burnout/i,
    q: "What's one stress technique that actually holds up under real pressure?",
  },
  {
    match: /social|connection|relationship|communi/i,
    q: "How do I get someone to actually change a habit, instead of just nodding along?",
  },
  {
    match: /substance|alcohol|smoking|tobacco|risky/i,
    q: "Is a glass of wine a night genuinely fine, or is that a comforting myth?",
  },
];

function starterQuestion(slug: string, name: string): string {
  const hay = `${slug} ${name}`;
  for (const c of CURATED_STARTERS) if (c.match.test(hay)) return c.q;
  return "What's one thing people in your field get wrong that you wish you could correct?";
}

// Reduce the agent's raw stream to something a steward can read in the hero.
// REFUSE/UNCOVERED are surfaced as their own kinds (the motivating "no answer
// yet" moment); the covered path emits labeled sections, so we show just the
// ANSWER prose.
function heroAnswerView(text: string): {
  kind: "answer" | "refuse" | "uncovered";
  body: string;
} {
  const t = text.trim();
  if (/^REFUSE:/i.test(t))
    return { kind: "refuse", body: t.replace(/^REFUSE:\s*/i, "") };
  if (/^UNCOVERED:/i.test(t))
    return { kind: "uncovered", body: t.replace(/^UNCOVERED:\s*/i, "") };
  const m = t.match(
    /ANSWER:\s*([\s\S]*?)(?=\n?(?:CITATION|PAPER|FINDING|INTERPRETATION):|$)/i,
  );
  const body = (m ? m[1] : t.replace(/^ANSWER:?\s*/i, ""))
    .replace(/\s*—\s*/g, ", ")
    .trim();
  return { kind: "answer", body };
}

/**
 * The post-onboarding hero for a brand-new steward. One action: make your
 * first answer. We pick ONE real question in their field, stream the AI's
 * CURRENT answer live, then route them into the governance-correct authoring
 * flow. For a thin or non-sleep pillar the agent REFUSEs/UNCOVEREDs — which we
 * frame as the opportunity, not an error.
 */
function FirstAnswerHero({
  slug,
  pillarName,
}: {
  slug: string;
  pillarName: string;
}) {
  // Cache the chosen question + streamed answer per pillar for the session, so
  // revisiting the dashboard (or an admin previewing the same new steward) does
  // not re-fire a paid LLM call. Read once on mount via a ref.
  const cacheKey = `palonur-faculty-hero:${slug}`;
  const cachedRef = useRef<
    | { question: string; clusterId: number | null; answer: string }
    | null
    | undefined
  >(undefined);
  if (cachedRef.current === undefined) {
    try {
      const raw = sessionStorage.getItem(cacheKey);
      cachedRef.current = raw ? JSON.parse(raw) : null;
    } catch {
      cachedRef.current = null;
    }
  }
  const cached = cachedRef.current;

  const [question, setQuestion] = useState<string | null>(
    cached?.question ?? null,
  );
  const [clusterId, setClusterId] = useState<number | null>(
    cached?.clusterId ?? null,
  );
  const [stream, setStream] = useState(cached?.answer ?? "");
  const [phase, setPhase] = useState<"idle" | "streaming" | "done" | "error">(
    cached ? "done" : "idle",
  );
  const startedRef = useRef(!!cached);

  const coverage = useQuery<CoverageDashboardData>({
    queryKey: ["faculty-coverage", slug],
    queryFn: () => fetchJson(`/api/faculty/pillars/${slug}/dashboard`),
    enabled: !cached,
  });

  // Pick ONE question: a clustered reader question (carries a clusterId so the
  // CTA can reuse the promote flow) → a low-confidence miss → a curated starter.
  useEffect(() => {
    if (question || coverage.isLoading) return;
    const d = coverage.data;
    const cluster = d?.clusters?.[0];
    if (cluster) {
      setQuestion(cluster.representativeQuestion);
      setClusterId(cluster.id);
      return;
    }
    const low = d?.lowConfidence?.[0];
    if (low) {
      setQuestion(low.question);
      return;
    }
    setQuestion(starterQuestion(slug, pillarName));
  }, [coverage.data, coverage.isLoading, question, slug, pillarName]);

  // Stream the live agent answer once a question is chosen. `log: false` keeps
  // this synthetic, auto-fired question out of coverage/reader-demand telemetry.
  useEffect(() => {
    if (!question || startedRef.current) return;
    startedRef.current = true;
    const ctrl = new AbortController();
    void (async () => {
      setPhase("streaming");
      let acc = "";
      try {
        const res = await fetch("/api/sleep-agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: question, log: false }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const line of parts) {
            if (!line.startsWith("data: ")) continue;
            try {
              const obj = JSON.parse(line.slice(6)) as { content?: string };
              if (obj.content) {
                acc += obj.content;
                setStream(acc);
              }
            } catch {
              /* ignore keepalives / non-JSON frames */
            }
          }
        }
        setPhase("done");
        try {
          sessionStorage.setItem(
            cacheKey,
            JSON.stringify({ question, clusterId, answer: acc }),
          );
        } catch {
          /* sessionStorage unavailable — fine, we'll just re-fetch next time */
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") setPhase("error");
      }
    })();
    return () => ctrl.abort();
  }, [question]);

  const view = stream ? heroAnswerView(stream) : null;
  const refusalLike =
    !!view && (view.kind === "refuse" || view.kind === "uncovered");
  const grounded = view?.kind === "answer" && view.body.length > 0;
  const noAnswer =
    refusalLike || phase === "error" || (phase === "done" && !grounded);

  return (
    <section
      className="mb-10 overflow-hidden rounded-2xl border border-[#E8DDD0] bg-gradient-to-br from-[#F9F5EE] to-[#F4ECDD]"
      data-testid="card-first-answer"
    >
      <div className="p-6 sm:p-9">
        <SectionEyebrow
          icon={<IconCompass />}
          label="Start here · your first answer"
          tone="cardinal"
        />
        <h1 className="font-serif text-3xl sm:text-4xl leading-tight text-[#572020] mb-3">
          Make your first answer
        </h1>
        <p className="text-[#7a5a4a] leading-relaxed max-w-2xl mb-7">
          Here's a real question someone in {pillarName} would ask. See what the
          AI says today, then make the answer yours: grounded in a source you
          stand behind, published in your name.
        </p>

        <div className="rounded-xl border border-[#E8DDD0] bg-white/70 p-5 sm:p-6">
          <p className="text-[10px] tracking-[0.22em] uppercase text-[#8a6a5a] mb-2">
            A reader asks
          </p>
          <p className="font-serif text-lg sm:text-xl text-[#572020]">
            {question ? `“${question}”` : "Finding a question in your field…"}
          </p>

          <div className="mt-5 border-t border-[#F0E8DD] pt-5">
            <p className="text-[10px] tracking-[0.22em] uppercase text-[#8a6a5a] mb-2">
              The AI today
            </p>
            {phase === "idle" || (phase === "streaming" && !stream) ? (
              <p className="text-sm text-[#8a6a5a] italic">Asking the AI…</p>
            ) : grounded ? (
              <p
                className="text-[15px] leading-relaxed text-[#3f2a2a] whitespace-pre-wrap"
                data-testid="text-hero-answer"
              >
                {view?.body}
                {phase === "streaming" && (
                  <span className="ml-0.5 inline-block h-4 w-[2px] -mb-0.5 animate-pulse bg-[#8C1515]" />
                )}
              </p>
            ) : noAnswer ? (
              <div data-testid="text-hero-noanswer">
                <p className="text-[15px] leading-relaxed text-[#572020]">
                  The AI has nothing of yours to answer with yet, so it holds
                  back rather than guess.
                </p>
                <p className="text-sm text-[#8a6a5a] mt-2">
                  That blank is the opportunity. The first grounded answer in{" "}
                  {pillarName} can be yours.
                </p>
              </div>
            ) : (
              <p className="text-[15px] leading-relaxed text-[#3f2a2a] whitespace-pre-wrap">
                {view?.body}
                <span className="ml-0.5 inline-block h-4 w-[2px] -mb-0.5 animate-pulse bg-[#8C1515]" />
              </p>
            )}
          </div>
        </div>

        <div className="mt-6">
          {clusterId != null ? (
            <div data-testid="hero-cta-cluster">
              <p className="text-sm text-[#572020] font-medium">
                Readers already asked this. Turn it into your answer:
              </p>
              <ClusterPromoteWidget slug={slug} clusterId={clusterId} />
            </div>
          ) : question ? (
            <Link
              href={`/answer?${new URLSearchParams({ slug, q: question }).toString()}`}
              className="inline-flex items-center gap-2 rounded-full bg-[#8C1515] px-6 py-3 text-sm font-medium text-white shadow-sm hover:bg-[#a01a1a] transition"
              data-testid="link-hero-make-answer"
            >
              <span aria-hidden>＋</span>
              Answer this question
              <span aria-hidden>→</span>
            </Link>
          ) : (
            <span
              className="inline-flex items-center gap-2 rounded-full bg-[#8C1515]/50 px-6 py-3 text-sm font-medium text-white"
              data-testid="link-hero-make-answer-pending"
            >
              Finding a question…
            </span>
          )}
        </div>
      </div>

      <ol className="grid gap-px bg-[#E8DDD0] border-t border-[#E8DDD0] sm:grid-cols-3">
        {[
          {
            t: "Add a source",
            d: "A paper, article, or note you'd stand behind. Every answer is grounded in it.",
          },
          {
            t: "Write the takeaway",
            d: "The plain-language point a reader should walk away with — in your words.",
          },
          {
            t: "Approve to go live",
            d: "One click and readers and the AI can cite it, with your name on it.",
          },
        ].map((s, i) => (
          <li
            key={s.t}
            className="bg-[#FBF7F0]/80 p-5"
            data-testid={`hero-step-${i + 1}`}
          >
            <div className="flex items-center gap-3 mb-2">
              <NumberBadge n={i + 1} />
              <h3 className="font-serif text-base text-[#572020]">{s.t}</h3>
            </div>
            <p className="text-xs text-[#8a6a5a] leading-relaxed">{s.d}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Day-one delegation path. One steward can't answer a whole field — so from
 * the start they can invite colleagues to draft answers (every draft lands in
 * their review queue; nothing publishes without their approval). Steward can
 * already invite into their own pillar (POST /api/faculty/invitations is
 * gated to steward), so no backend change. Disabled under admin view-as.
 */
function ScaleWithTeamPanel({
  slug,
  pillarId,
  pillarName,
}: {
  slug: string;
  pillarId: number;
  pillarName: string;
}) {
  const viewAs = useViewAs();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"contributor" | "advisor">("contributor");
  const [institution, setInstitution] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const inviteMutation = useMutation({
    mutationFn: (vars: {
      email: string;
      role: string;
      pillarId: number;
      institution?: string;
    }) =>
      fetchJson<{ email: string; role: string }>("/api/faculty/invitations", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: (r) => {
      setMsg(
        `Invitation sent to ${r.email} as ${r.role}. They'll draft; you approve.`,
      );
      setEmail("");
      setInstitution("");
    },
    onError: (e: Error) => setMsg(`Couldn't send: ${e.message}`),
  });

  return (
    <section
      className="mb-12 overflow-hidden rounded-2xl border border-[#E8DDD0] bg-white/40"
      data-testid="panel-scale-team"
    >
      <div className="p-6 sm:p-8">
        <SectionEyebrow
          icon={<IconShield />}
          label="Your data, your terms"
          tone="cardinal"
        />
        <h2 className="font-serif text-2xl sm:text-3xl text-[#572020] mb-3">
          Your work stays yours — protected and always cited
        </h2>
        <p className="text-[#7a5a4a] leading-relaxed max-w-2xl mb-3">
          Add your papers, talks, and notes to {pillarName}. They live on a
          secure, private server in your pillar's library, under your control.
        </p>
        <p className="text-[#7a5a4a] leading-relaxed max-w-2xl mb-6">
          <span className="font-medium text-[#572020]">
            This platform is the distribution layer, not the source.
          </span>{" "}
          Your data is never used to train any AI model. It's only ever
          retrieved to answer a reader's question — always with a citation back
          to you. You decide what's shared, what stays private, and what's
          withdrawn, at any time.
        </p>

        <div className="mb-7">
          <Link
            href={`/pillars/${slug}/library`}
            className="inline-flex items-center gap-2 rounded-full bg-[#8C1515] px-6 py-3 text-sm font-medium text-white shadow-sm hover:bg-[#a01a1a] transition"
            data-testid="link-upload-data"
          >
            <span aria-hidden>↑</span>
            Upload your data
            <span aria-hidden>→</span>
          </Link>
        </div>
      </div>

      <ol className="grid gap-px bg-[#E8DDD0] border-t border-[#E8DDD0] sm:grid-cols-3">
        {[
          {
            t: "You upload",
            d: "Drop in a paper or note. It's stored privately in your library.",
          },
          {
            t: "It waits for you",
            d: "Nothing is published or citable until you approve it.",
          },
          {
            t: "Readers get the faucet",
            d: "When it's live, the AI cites your source — never your raw files, never a trained copy.",
          },
        ].map((s, i) => (
          <li
            key={s.t}
            className="bg-[#FBF7F0]/80 p-5"
            data-testid={`team-step-${i + 1}`}
          >
            <div className="flex items-center gap-3 mb-2">
              <NumberBadge n={i + 1} />
              <h3 className="font-serif text-base text-[#572020]">{s.t}</h3>
            </div>
            <p className="text-xs text-[#8a6a5a] leading-relaxed">{s.d}</p>
          </li>
        ))}
      </ol>

      <div className="border-t border-[#E8DDD0] bg-white/30 p-6 sm:p-8">
        <SectionEyebrow
          icon={<IconPulse />}
          label="Optional · scale with your team"
          tone="muted"
        />
        <h3 className="font-serif text-xl text-[#572020] mb-2">
          You don't have to answer everything alone
        </h3>
        <p className="text-[#7a5a4a] leading-relaxed max-w-2xl mb-5">
          When you're ready, bring in colleagues to draft answers in{" "}
          {pillarName}. Every draft lands in your review queue, and nothing goes
          live until you approve it. Your name still stands behind the work.
        </p>

        {viewAs ? (
          <p
            className="text-sm text-[#8a6a5a] italic"
            data-testid="team-invite-preview-note"
          >
            Inviting is disabled while previewing as {viewAs.name}.
          </p>
        ) : (
          <div className="rounded-xl border border-[#E8DDD0] bg-white/60 p-5">
            <p className="text-sm font-medium text-[#572020] mb-3">
              Invite a colleague into {pillarName}
            </p>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <input
                type="email"
                placeholder="email@stanford.edu"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="flex-1 bg-white border border-[#E8DDD0] rounded-lg px-4 py-2 text-[#572020]"
                data-testid="input-team-invite-email"
              />
              <select
                value={role}
                onChange={(e) =>
                  setRole(e.target.value as "contributor" | "advisor")
                }
                className="bg-white border border-[#E8DDD0] rounded-lg px-4 py-2 text-[#572020]"
                data-testid="select-team-invite-role"
              >
                <option value="contributor">Contributor</option>
                <option value="advisor">Advisor (cross-pillar lens)</option>
              </select>
              <button
                type="button"
                onClick={() =>
                  email &&
                  inviteMutation.mutate({
                    email,
                    role,
                    pillarId,
                    institution: institution.trim() || undefined,
                  })
                }
                disabled={inviteMutation.isPending || !email}
                className="bg-[#8C1515] text-white px-5 py-2 rounded-lg font-medium hover:bg-[#a01a1a] disabled:opacity-50 transition whitespace-nowrap"
                data-testid="button-team-invite-send"
              >
                {inviteMutation.isPending ? "Sending…" : "Send invite"}
              </button>
            </div>
            <input
              type="text"
              placeholder="Their institution (optional) — e.g. Stanford Medicine"
              value={institution}
              onChange={(e) => setInstitution(e.target.value)}
              className="mt-3 w-full bg-white border border-[#E8DDD0] rounded-lg px-4 py-2 text-[#572020] text-sm"
              data-testid="input-team-invite-institution"
            />
            {msg && (
              <p
                className="text-sm text-[#8a6a5a] mt-3"
                data-testid="text-team-invite-msg"
              >
                {msg}
              </p>
            )}
          </div>
        )}

        <div className="mt-5">
          <Link
            href={`/pillars/${slug}/inbox`}
            className="text-sm font-medium text-[#8C1515] hover:underline"
            data-testid="link-team-review-queue"
          >
            Open your review queue →
          </Link>
        </div>
      </div>
    </section>
  );
}

/**
 * Two-step progress checklist shown at the top of a new steward's focused
 * onboarding dashboard. Real-data-only: each step's done state is derived from
 * server counts (an approved interpretation; an uploaded source).
 */
function OnboardingChecklist({
  answeredFirst,
  uploadedData,
}: {
  answeredFirst: boolean;
  uploadedData: boolean;
}) {
  const steps = [
    { label: "Make your first answer", done: answeredFirst },
    { label: "Bring in your data", done: uploadedData },
  ];
  return (
    <div
      className="mb-8 rounded-2xl border border-[#E8DDD0] bg-white/50 px-6 py-5"
      data-testid="onboarding-checklist"
    >
      <p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-3">
        Two steps to bring your pillar to life
      </p>
      <ul className="space-y-2">
        {steps.map((s) => (
          <li key={s.label} className="flex items-center gap-3">
            <span
              className={`flex h-6 w-6 flex-none items-center justify-center rounded-full text-[13px] ${
                s.done
                  ? "bg-[#8C1515] text-white"
                  : "border border-[#E8DDD0] bg-white text-[#c9b8a8]"
              }`}
              aria-hidden
            >
              {s.done ? "✓" : "○"}
            </span>
            <span
              className={`text-sm ${
                s.done
                  ? "text-[#8a6a5a] line-through"
                  : "text-[#572020] font-medium"
              }`}
            >
              {s.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Replaces FirstAnswerHero once the steward has published their first answer:
 * a compact confirmation that keeps the "add another" path one click away.
 */
function FirstAnswerDoneCard({
  slug,
  pillarName,
}: {
  slug: string;
  pillarName: string;
}) {
  return (
    <section
      className="mb-8 rounded-2xl border border-[#E8DDD0] bg-gradient-to-br from-[#F9F5EE] to-[#F4ECDD] p-6 sm:p-8"
      data-testid="card-first-answer-done"
    >
      <SectionEyebrow
        icon={<IconCompass />}
        label="Your first answer"
        tone="cardinal"
      />
      <h2 className="font-serif text-2xl sm:text-3xl text-[#572020] mb-2">
        Your first answer is live ✓
      </h2>
      <p className="text-[#7a5a4a] leading-relaxed max-w-2xl mb-5">
        Readers and the AI can now cite {pillarName} with your name on it. Keep
        going — add more answers whenever you like.
      </p>
      <Link
        href={`/pillars/${slug}/library`}
        className="inline-flex items-center gap-2 rounded-full bg-[#8C1515] px-6 py-3 text-sm font-medium text-white shadow-sm hover:bg-[#a01a1a] transition"
        data-testid="link-add-another-answer"
      >
        <span aria-hidden>＋</span>
        Add another answer
        <span aria-hidden>→</span>
      </Link>
    </section>
  );
}

/**
 * "Upload your data safely" panel for new stewards. The whole point is trust:
 * the data stays theirs, is never used to train a model, and Palonur is the
 * faucet (retrieval with a citation) not the well (a trained copy). CTA routes
 * to the pillar library where the real upload UI lives. Shows a done state once
 * the steward has uploaded at least one source.
 */
function UploadDataPanel({
  slug,
  pillarName,
  done,
}: {
  slug: string;
  pillarName: string;
  done: boolean;
}) {
  return (
    <section
      className="mb-8 overflow-hidden rounded-2xl border border-[#E8DDD0] bg-white/40"
      data-testid="panel-upload-data"
    >
      <div className="p-6 sm:p-9">
        <SectionEyebrow
          icon={<IconShield />}
          label="Your data, your terms"
          tone="cardinal"
        />
        <h2 className="font-serif text-2xl sm:text-3xl text-[#572020] mb-3">
          {done
            ? "Your data is in — and it's yours"
            : "Bring your work in — it stays yours"}
        </h2>
        <p className="text-[#7a5a4a] leading-relaxed max-w-2xl mb-3">
          Add your papers, talks, and notes to {pillarName}. They live in your
          pillar's private library, under your control.
        </p>
        <p className="text-[#7a5a4a] leading-relaxed max-w-2xl mb-6">
          <span className="font-medium text-[#572020]">
            This platform is the distribution layer, not the source.
          </span>{" "}
          Your data is never used to train any AI model. It's only ever
          retrieved to answer a reader's question — always with a citation back
          to you. You decide what's shared, what stays private, and what's
          withdrawn, at any time.
        </p>

        <div className="mb-7">
          {done ? (
            <Link
              href={`/pillars/${slug}/library`}
              className="inline-flex items-center gap-2 rounded-full border border-[#8C1515] px-6 py-3 text-sm font-medium text-[#8C1515] hover:bg-[#8C1515]/5 transition"
              data-testid="link-add-more-data"
            >
              <span aria-hidden>✓</span>
              You've added your first source — add more
              <span aria-hidden>→</span>
            </Link>
          ) : (
            <Link
              href={`/pillars/${slug}/library`}
              className="inline-flex items-center gap-2 rounded-full bg-[#8C1515] px-6 py-3 text-sm font-medium text-white shadow-sm hover:bg-[#a01a1a] transition"
              data-testid="link-upload-data"
            >
              <span aria-hidden>↑</span>
              Upload your data
              <span aria-hidden>→</span>
            </Link>
          )}
        </div>
      </div>

      <ol className="grid gap-px bg-[#E8DDD0] border-t border-[#E8DDD0] sm:grid-cols-3">
        {[
          {
            t: "You upload",
            d: "Drop in a paper or note. It's stored privately in your library.",
          },
          {
            t: "It waits for you",
            d: "Nothing is published or citable until you approve it.",
          },
          {
            t: "Readers get the faucet",
            d: "When it's live, the AI cites your source — never your raw files, never a trained copy.",
          },
        ].map((s, i) => (
          <li key={s.t} className="bg-[#FBF7F0]/80 p-5">
            <div className="flex items-center gap-3 mb-2">
              <NumberBadge n={i + 1} />
              <h3 className="font-serif text-base text-[#572020]">{s.t}</h3>
            </div>
            <p className="text-xs text-[#8a6a5a] leading-relaxed">{s.d}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The single pillar card a new steward sees — their own pillar — instead of the
 * full "Your pillars" grid.
 */
function OwnPillarCard({
  slug,
  name,
  description,
}: {
  slug: string;
  name: string;
  description: string | null;
}) {
  return (
    <Link
      href={`/pillars/${slug}`}
      className="group block rounded-xl border border-[#E8DDD0] bg-white/40 p-6 transition hover:border-[#8C1515] hover:bg-white/70 hover:shadow-sm"
      data-testid={`link-pillar-${slug}`}
    >
      <div className="flex items-center gap-3 mb-2">
        <span
          className="flex-none inline-flex h-12 w-12 items-center justify-center rounded-lg bg-[#8C1515]/5 overflow-hidden"
          aria-hidden
        >
          <img
            src={pillarIllu(slug)}
            alt=""
            className="h-11 w-11 object-contain"
          />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-wider uppercase text-[#8C1515] mb-1">
            Your pillar
          </p>
          <h2 className="font-serif text-xl text-[#572020] truncate">{name}</h2>
        </div>
      </div>
      {description && (
        <p className="text-sm text-[#8a6a5a] leading-relaxed">{description}</p>
      )}
      <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[#8C1515] opacity-0 transition group-hover:opacity-100">
        Open your pillar →
      </span>
    </Link>
  );
}

/**
 * The focused first-run dashboard for a new single-pillar steward: ONLY the
 * first-answer action, the "upload your data safely" panel, and their own
 * pillar card. No team-scaling, cross-pillar insights, or pillar grid until
 * they've both answered their first question AND brought in their data.
 */
function MinimalOnboarding({
  pillar,
  answeredFirst,
  uploadedData,
}: {
  pillar: { slug: string; name: string; description: string | null };
  answeredFirst: boolean;
  uploadedData: boolean;
}) {
  // Mark this browser session as actively onboarding so finishing both steps
  // in-session lands on the steward dashboard, while a later fresh login (no
  // marker) routes straight to the pillar workspace.
  useEffect(() => {
    try {
      sessionStorage.setItem(ONBOARDING_ACTIVE_KEY, "1");
    } catch {
      /* sessionStorage unavailable — the redirect simply won't engage */
    }
  }, []);

  return (
    <>
      <OnboardingChecklist
        answeredFirst={answeredFirst}
        uploadedData={uploadedData}
      />
      {answeredFirst ? (
        <FirstAnswerDoneCard slug={pillar.slug} pillarName={pillar.name} />
      ) : (
        <FirstAnswerHero slug={pillar.slug} pillarName={pillar.name} />
      )}
      <UploadDataPanel
        slug={pillar.slug}
        pillarName={pillar.name}
        done={uploadedData}
      />
      <OwnPillarCard
        slug={pillar.slug}
        name={pillar.name}
        description={pillar.description}
      />
    </>
  );
}

// The faculty portal's main loop, surfaced as the lead of a steward's
// dashboard: upload a paper → discuss it with your team → approve, and it goes
// live in your pillar's agent. Reuses existing routes (library / inbox); shows
// only real counts (sourceCount / approved interpretations), nothing fabricated.
function CoreLoopPanel({
  slug,
  pillarName,
  sourceCount,
  liveAnswers,
}: {
  slug: string;
  pillarName: string;
  sourceCount: number | null;
  liveAnswers: number | null;
}) {
  const steps = [
    {
      n: 1,
      title: "Add a paper",
      body: "Upload a paper, article, or note worth standing behind.",
      meta:
        sourceCount === null
          ? null
          : `${sourceCount} source${sourceCount === 1 ? "" : "s"}`,
      href: `/pillars/${slug}/library`,
      cta: "Open library",
      testId: "core-loop-add",
    },
    {
      n: 2,
      title: "Discuss with your team",
      body: "Invite colleagues and debate the paper — the discussion shapes the interpretation.",
      meta: null,
      href: `/pillars/${slug}/library`,
      cta: "Discuss papers",
      testId: "core-loop-discuss",
    },
    {
      n: 3,
      title: "Approve — it goes live",
      body: "An approved interpretation becomes a grounded answer in your pillar's agent.",
      meta:
        liveAnswers === null
          ? null
          : `${liveAnswers} live answer${liveAnswers === 1 ? "" : "s"}`,
      href: `/pillars/${slug}/inbox`,
      cta: "Review & approve",
      testId: "core-loop-approve",
    },
  ];
  return (
    <section className="mb-12" data-testid="core-loop-panel">
      <SectionEyebrow
        icon={<IconCompass />}
        label="Your faculty workspace"
        tone="cardinal"
      />
      <h1 className="font-serif text-2xl sm:text-3xl text-[#572020] leading-tight mb-2">
        Bring your papers to life
      </h1>
      <p className="text-[#8a6a5a] mb-6 max-w-2xl">
        The heart of the portal: upload the work you stand behind, discuss it with
        your team, and turn that conversation into a grounded answer that goes
        live in {pillarName}.
      </p>
      <div className="grid gap-4 sm:grid-cols-3">
        {steps.map((s) => (
          <Link
            key={s.n}
            href={s.href}
            data-testid={s.testId}
            className="group flex flex-col rounded-2xl border border-[#E8DDD0] bg-white/50 p-5 transition hover:border-[#8C1515]"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#8C1515] text-xs font-medium text-white">
                {s.n}
              </span>
              <span className="font-serif text-lg text-[#572020]">
                {s.title}
              </span>
            </div>
            <p className="flex-1 text-sm text-[#8a6a5a]">{s.body}</p>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-sm font-medium text-[#8C1515] group-hover:text-[#a01a1a]">
                {s.cta} →
              </span>
              {s.meta && (
                <span className="text-xs text-[#8a6a5a]">{s.meta}</span>
              )}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

// One process card in the lean steward launcher: a single, generously sized
// link to the existing surface that does the work. One primary action, no
// nested controls (so the whole card can be a single anchor).
function ProcessCard({
  n,
  eyebrow,
  title,
  desc,
  cta,
  href,
  testId,
}: {
  n: number;
  eyebrow: string;
  title: string;
  desc: React.ReactNode;
  cta: string;
  href: string;
  testId: string;
}) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className="group flex items-start gap-5 border border-[#D5D0C8] bg-white p-6 sm:p-7 transition hover:border-[#8C1515] hover:shadow-md"
    >
      <span className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center border border-[#D5D0C8] font-serif text-lg font-semibold text-[#8C1515] transition group-hover:border-[#8C1515]">
        {n}
      </span>
      <span className="min-w-0">
        <span className="block text-[11px] font-semibold tracking-[0.2em] uppercase text-[#8C1515] mb-2">
          {eyebrow}
        </span>
        <span className="block font-serif text-xl sm:text-2xl font-semibold text-[#2E2D29] mb-2">
          {title}
        </span>
        <span className="block text-[#5F574F] leading-relaxed mb-4">
          {desc}
        </span>
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-[#8C1515]">
          {cta}
          <span aria-hidden className="transition group-hover:translate-x-0.5">
            →
          </span>
        </span>
      </span>
    </Link>
  );
}

const distributionDesc = (
  <span className="flex flex-wrap gap-2">
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[#E8DDD0] bg-[#FBF7F0] px-3 py-1 text-sm text-[#572020]">
      <span aria-hidden>✦</span> AI guide
    </span>
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[#E8DDD0] bg-[#FBF7F0] px-3 py-1 text-sm text-[#572020]">
      <span aria-hidden>✉</span> Newsletter
    </span>
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[#E8DDD0] bg-[#FBF7F0] px-3 py-1 text-sm text-[#8a6a5a] italic">
      <span aria-hidden>⋯</span> More soon
    </span>
  </span>
);

// The steward's whole dashboard body: greet, then pick one of three jobs.
// Distribution branches on whether the pillar is part of the Stanford
// Lifestyle Medicine program — only LM stewards can offer an article to the
// shared SLM newsletter; everyone else runs their own publication.
function StewardProcesses({
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

        {/* Source Library */}
        <Link
          href={`/pillars/${slug}/library`}
          className="group flex flex-col md:flex-row md:items-center justify-between border-r border-b border-gray-200 bg-white p-6 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-[#8C1515] focus:ring-inset"
          data-testid="link-process-library"
        >
          <div className="max-w-2xl">
            <p className="text-[10px] tracking-[0.2em] font-bold text-[#8C1515] uppercase mb-2">Curate your knowledge</p>
            <h3 className="font-serif text-xl text-[#2E2D29] mb-1">Source Library</h3>
            <p className="text-sm text-[#544948] leading-relaxed">
              Stanford Lifestyle Medicine automatically looks for papers and articles published under your name and places matches here. Review these matches, exclude what doesn't fit this pillar, and manually add anything we missed.
            </p>
          </div>
          <div className="mt-4 md:mt-0 md:pl-6 flex items-center md:flex-col md:items-end gap-3 md:gap-1">
             <span className="text-[#8C1515] font-medium text-sm group-hover:underline">Review Matches &rarr;</span>
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
}

/**
 * Steward Q&A earnings summary. Readers can subscribe ($9/mo) to ask a
 * steward's agent unlimited questions on their publication page; each paid
 * invoice mints an 80/20 ledger entry. This card shows the steward THEIR
 * share — subscriber count + amount accrued. Renders nothing until there is
 * at least one subscriber or ledger entry, so a pre-revenue dashboard stays
 * clean.
 */
function StewardEarningsCard() {
  const { data, isLoading, error } = useQuery<{
    sharePercent: number;
    totals: { grossCents: number; stewardCents: number; palonurCents: number };
    invoiceCount: number;
    subscribers: Record<string, number>;
  }>({
    queryKey: ["steward-earnings"],
    queryFn: () => fetchJson("/api/faculty/earnings"),
  });

  if (isLoading || error || !data) return null;
  const subscriberCount = Object.values(data.subscribers).reduce(
    (a, b) => a + b,
    0,
  );
  if (data.invoiceCount === 0 && subscriberCount === 0) return null;
  const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

  return (
    <section
      className="mb-12 rounded-2xl border border-[#E8DDD0] bg-white/50 p-6 sm:p-7"
      data-testid="steward-earnings-card"
    >
      <p className="text-[10px] tracking-[0.25em] uppercase text-[#8C1515] mb-2">
        Your Q&amp;A earnings
      </p>
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
        <div>
          <span className="font-serif text-3xl text-[#572020]">
            {dollars(data.totals.stewardCents)}
          </span>
          <span className="ml-2 text-sm text-[#8a6a5a]">
            accrued ({data.sharePercent}% of {dollars(data.totals.grossCents)})
          </span>
        </div>
        <div className="text-sm text-[#8a6a5a]">
          {subscriberCount} active subscriber{subscriberCount === 1 ? "" : "s"}{" "}
          · {data.invoiceCount} paid invoice
          {data.invoiceCount === 1 ? "" : "s"}
        </div>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-[#8a6a5a]">
        Readers subscribe on your publication page to ask your agent unlimited
        questions. Your share accrues per paid invoice and is reimbursed by
        Stanford — no action needed.
      </p>
    </section>
  );
}

// ─── Pillar Analytics Dashboard ───────────────────────────────────────────────

type PillarAnalyticsData = {
  sharePercent: number;
  uniqueUsers: number;
  activeSubscribers: number;
  invoiceCount: number;
  thisMonth: { grossCents: number; stewardCents: number; palonurCents: number };
  ytd: { grossCents: number; stewardCents: number; palonurCents: number };
  allTime: { grossCents: number; stewardCents: number; palonurCents: number };
  monthly: Array<{
    month: string;
    label: string;
    grossCents: number;
    stewardCents: number;
    palonurCents: number;
  }>;
};

type CorpusSearchData = {
  query: string;
  groups: Array<{
    representative: string;
    hits: number;
    clusterId: number | null;
    hasUncovered: boolean;
  }>;
};

type PayoutSettings = { autoPayout: boolean };

function AnalyticsStatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-[#E8DDD0] bg-white/60 p-5">
      <p className="text-[10px] tracking-[0.2em] uppercase text-[#8C1515] mb-2">
        {label}
      </p>
      <p className="font-serif text-3xl text-[#3a1c1c]">{value}</p>
      {sub && <p className="mt-1 text-xs text-[#b09080]">{sub}</p>}
    </div>
  );
}

function MonthlyRevenueChart({
  monthly,
}: {
  monthly: PillarAnalyticsData["monthly"];
}) {
  const maxGross = Math.max(...monthly.map((m) => m.grossCents), 1);
  const BAR_MAX_PX = 120;

  return (
    <div className="mt-4">
      <div
        className="flex items-end gap-1.5"
        style={{ height: `${BAR_MAX_PX}px` }}
      >
        {monthly.map((m) => {
          const pct = m.grossCents / maxGross;
          const barH = Math.max(pct * BAR_MAX_PX, 4);
          const stewardH =
            m.grossCents > 0 ? (m.stewardCents / m.grossCents) * barH : barH;
          const palonurH = barH - stewardH;
          const tooltip = `${m.label}: $${(m.grossCents / 100).toFixed(2)} gross · $${(m.stewardCents / 100).toFixed(2)} yours`;
          return (
            <div
              key={m.month}
              className="flex flex-col items-center flex-1 group"
            >
              <div
                className="w-full flex flex-col rounded-t-sm overflow-hidden cursor-default"
                style={{ height: `${barH}px` }}
                title={tooltip}
              >
                <div
                  className="w-full bg-[#E8DDD0] group-hover:bg-[#cdbdad] transition-colors"
                  style={{ height: `${palonurH}px` }}
                />
                <div
                  className="w-full bg-[#8C1515] group-hover:bg-[#7a1212] transition-colors"
                  style={{ height: `${stewardH}px` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      {/* Month labels */}
      <div className="flex gap-1.5 mt-1.5">
        {monthly.map((m) => (
          <div key={m.month} className="flex-1 text-center">
            <span className="text-[8px] text-[#b09080] leading-none">
              {m.label.replace(/ '\d\d$/, "")}
            </span>
          </div>
        ))}
      </div>
      {/* Legend */}
      <div className="mt-3 flex items-center gap-5 text-xs text-[#8a6a5a]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#8C1515]" />
          You (80%)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#E8DDD0]" />
          Platform (20%)
        </span>
      </div>
    </div>
  );
}

function PillarAnalytics() {
  const { slug } = useParams<{ slug: string }>();
  const qc = useQueryClient();
  const [searchInput, setSearchInput] = useState("");
  const [corpusQ, setCorpusQ] = useState("");
  const [payoutMsg, setPayoutMsg] = useState<string | null>(null);

  const dollars = (c: number) =>
    c === 0 ? "$0.00" : `$${(c / 100).toFixed(2)}`;

  const { data: analytics, isLoading: analyticsLoading } =
    useQuery<PillarAnalyticsData>({
      queryKey: ["pillar-analytics", slug],
      queryFn: () => fetchJson(`/api/faculty/pillars/${slug}/analytics`),
    });

  const { data: payoutSettings } = useQuery<PayoutSettings>({
    queryKey: ["pillar-payout-settings", slug],
    queryFn: () => fetchJson(`/api/faculty/pillars/${slug}/payout-settings`),
  });

  const { data: corpusData, isFetching: corpusFetching } =
    useQuery<CorpusSearchData>({
      queryKey: ["pillar-corpus-search", slug, corpusQ],
      queryFn: () =>
        fetchJson(
          `/api/faculty/pillars/${slug}/corpus-search?q=${encodeURIComponent(corpusQ)}`,
        ),
    });

  const toggleMutation = useMutation({
    mutationFn: (autoPayout: boolean) =>
      fetchJson(`/api/faculty/pillars/${slug}/payout-settings`, {
        method: "PATCH",
        body: JSON.stringify({ autoPayout }),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["pillar-payout-settings", slug] }),
  });

  const requestMutation = useMutation({
    mutationFn: () =>
      fetchJson<{ message: string }>(
        `/api/faculty/pillars/${slug}/payout/request`,
        { method: "POST", body: JSON.stringify({}) },
      ),
    onSuccess: (d) => setPayoutMsg(d.message),
  });

  return (
    <PortalShell>
      <Link
        href={`/pillars/${slug}`}
        className="inline-flex items-center gap-1 text-sm text-[#8a6a5a] hover:text-[#572020] transition-colors mb-6"
      >
        &#8592; Back to pillar
      </Link>

      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] tracking-[0.25em] text-[#8C1515] uppercase mb-1">
            Analytics
          </p>
          <h1 className="font-serif text-3xl font-medium text-[#3a1c1c]">
            Your dashboard
          </h1>
        </div>
        <a
          href={`/api/faculty/pillars/${slug}/analytics/export.csv`}
          download
          className="shrink-0 mt-2 inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-full border border-[#8C1515] text-[#8C1515] hover:bg-[#8C1515] hover:text-white transition-colors"
          data-testid="button-download-earnings-csv"
        >
          &#8595; Download CSV
        </a>
      </div>

      {analyticsLoading ? (
        <p className="text-[#8a6a5a]">Loading…</p>
      ) : analytics ? (
        <div className="space-y-8">
          {/* ── Hero stats row ── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <AnalyticsStatCard
              label="All-time users"
              value={analytics.uniqueUsers.toLocaleString()}
              sub="unique sessions"
            />
            <AnalyticsStatCard
              label="Subscribers"
              value={analytics.activeSubscribers.toLocaleString()}
              sub="paying now"
            />
            <AnalyticsStatCard
              label="This month"
              value={dollars(analytics.thisMonth.stewardCents)}
              sub={`of ${dollars(analytics.thisMonth.grossCents)} gross`}
            />
            <AnalyticsStatCard
              label="Year to date"
              value={dollars(analytics.ytd.stewardCents)}
              sub={`of ${dollars(analytics.ytd.grossCents)} gross`}
            />
          </div>

          {/* ── Monthly revenue chart ── */}
          {analytics.monthly.length > 0 && (
            <section className="rounded-2xl border border-[#E8DDD0] bg-white/60 p-6">
              <p className="text-[10px] tracking-[0.2em] uppercase text-[#8C1515] mb-1">
                Monthly revenue
              </p>
              <p className="text-sm text-[#8a6a5a]">
                Last {analytics.monthly.length} month
                {analytics.monthly.length === 1 ? "" : "s"} · hover a bar for
                exact amounts
              </p>
              <MonthlyRevenueChart monthly={analytics.monthly} />
            </section>
          )}

          {/* ── Payout section ── */}
          <section className="rounded-2xl border border-[#E8DDD0] bg-white/60 p-6">
            <p className="text-[10px] tracking-[0.2em] uppercase text-[#8C1515] mb-4">
              Payouts
            </p>

            {/* Split pill */}
            <div className="flex rounded-full overflow-hidden text-xs font-medium mb-6 max-w-sm">
              <div className="bg-[#8C1515] text-white text-center py-2 px-4 flex-1">
                You · {analytics.sharePercent}% ·{" "}
                {dollars(analytics.allTime.stewardCents)} all-time
              </div>
              <div className="bg-[#E8DDD0] text-[#8a6a5a] text-center py-2 px-3 shrink-0">
                Platform · {100 - analytics.sharePercent}%
              </div>
            </div>

            {/* Auto-payout toggle */}
            {payoutSettings !== undefined && (
              <div className="flex items-center justify-between mb-5 p-4 rounded-xl bg-[#FDFAF6] border border-[#E8DDD0]">
                <div className="mr-4">
                  <p className="text-sm font-medium text-[#3a1c1c]">
                    Automatic monthly payout
                  </p>
                  <p className="text-xs text-[#8a6a5a] mt-0.5">
                    The platform will process your share automatically each month
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={
                    payoutSettings.autoPayout
                      ? "Disable auto-payout"
                      : "Enable auto-payout"
                  }
                  onClick={() =>
                    toggleMutation.mutate(!payoutSettings.autoPayout)
                  }
                  disabled={toggleMutation.isPending}
                  className={`relative shrink-0 w-12 h-6 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8C1515] ${
                    payoutSettings.autoPayout ? "bg-[#8C1515]" : "bg-[#D4C4B4]"
                  }`}
                >
                  <span
                    className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                      payoutSettings.autoPayout
                        ? "translate-x-7"
                        : "translate-x-1"
                    }`}
                  />
                </button>
              </div>
            )}

            {/* Manual payout request */}
            {payoutMsg ? (
              <p className="text-sm text-[#3a9a4f] bg-[#f0faf3] rounded-xl px-4 py-3 border border-[#b8e6c4]">
                {payoutMsg}
              </p>
            ) : (
              <button
                type="button"
                onClick={() => requestMutation.mutate()}
                disabled={requestMutation.isPending}
                className="text-sm px-5 py-2.5 rounded-full border border-[#8C1515] text-[#8C1515] hover:bg-[#8C1515] hover:text-white transition-colors disabled:opacity-50"
              >
                {requestMutation.isPending
                  ? "Requesting…"
                  : "Request payout now \u2192"}
              </button>
            )}
          </section>

          {/* ── Corpus search ── */}
          <section className="rounded-2xl border border-[#E8DDD0] bg-white/60 p-6">
            <p className="text-[10px] tracking-[0.2em] uppercase text-[#8C1515] mb-1">
              What your audience is asking
            </p>
            <p className="text-sm text-[#8a6a5a] mb-4">
              Search questions your pillar has received. Leave blank to see the
              most-asked.
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                setCorpusQ(searchInput);
              }}
              className="flex gap-2 mb-6"
            >
              <input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="e.g. sleep, loneliness, stress…"
                className="flex-1 rounded-xl border border-[#E8DDD0] bg-white px-4 py-2.5 text-sm text-[#3a1c1c] placeholder:text-[#c4a898] focus:outline-none focus:border-[#8C1515]"
              />
              <button
                type="submit"
                className="px-5 py-2.5 rounded-xl bg-[#8C1515] text-white text-sm hover:bg-[#7a1212] transition-colors"
              >
                {corpusFetching ? "\u2026" : "Search"}
              </button>
              {corpusQ && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchInput("");
                    setCorpusQ("");
                  }}
                  className="px-3 py-2.5 rounded-xl border border-[#E8DDD0] text-[#8a6a5a] text-sm hover:border-[#8C1515] transition-colors"
                >
                  Clear
                </button>
              )}
            </form>

            {corpusData && corpusData.groups.length === 0 && (
              <p className="text-sm text-[#b09080]">
                No questions found
                {corpusQ ? ` matching \u201c${corpusQ}\u201d` : " yet"}.
              </p>
            )}

            <ol className="space-y-2">
              {corpusData?.groups.map((g, i) => (
                <li
                  key={i}
                  className="flex items-start justify-between gap-4 rounded-xl px-4 py-3 bg-[#FDFAF6] border border-[#F0E8E0]"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <span className="text-[10px] tabular-nums text-[#b09080] w-5 text-right shrink-0 pt-0.5">
                      {i + 1}
                    </span>
                    <p className="text-sm text-[#3a1c1c] leading-snug">
                      {g.representative}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {g.hasUncovered && (
                      <span
                        title="Some asks in this cluster went unanswered"
                        className="text-[10px] text-[#8a6a5a] bg-[#F0E8E0] rounded-full px-2 py-0.5"
                      >
                        gap
                      </span>
                    )}
                    <span className="text-xs font-medium text-[#8C1515] bg-[#8C1515]/10 rounded-full px-2.5 py-0.5">
                      &#215;{g.hits}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      ) : (
        <p className="text-sm text-[#E8352A]">Could not load analytics.</p>
      )}
    </PortalShell>
  );
}

// ---------- Research Validation Card ----------
// Shown on the steward dashboard. Explains the Research Validation Triage
// framework — two axes + three zones — so faculty understand what their
// approval workflow produces downstream.
function ResearchValidationCard() {
  return (
    <section
      className="mb-12 rounded-2xl border border-[#E8DDD0] bg-white/50 p-6 sm:p-7"
      data-testid="research-validation-card"
    >
      <p className="text-[10px] tracking-[0.25em] uppercase text-[#8C1515] mb-2">
        Research Validation Triage
      </p>
      <h3 className="font-serif text-xl text-[#572020] mb-3 leading-snug">
        How the system decides what a visitor sees
      </h3>
      <p className="text-sm leading-relaxed text-[#8a6a5a] mb-5">
        Every answer carries a badge. The triage framework classifies answers
        along two axes and maps them to three zones — each zone has a defined
        system behavior and a specific action you can take to move questions up.
      </p>

      {/* Two axes */}
      <div className="grid gap-3 sm:grid-cols-2 mb-5">
        <div className="rounded-xl border border-[#E8DDD0] bg-[#FBF7F0] p-4">
          <p className="text-[11px] font-semibold tracking-widest uppercase text-[#8a6a5a] mb-1">
            Axis 1 — Reversibility
          </p>
          <p className="text-sm text-[#572020] leading-relaxed">
            Can the answer be corrected by approving more material? A covered
            answer whose citation was verified is <strong>reversible</strong> at
            the content level — improve the corpus, the answer improves. A
            refused or off-topic answer is{" "}
            <strong>structurally irreversible</strong> without a
            question-routing change.
          </p>
        </div>
        <div className="rounded-xl border border-[#E8DDD0] bg-[#FBF7F0] p-4">
          <p className="text-[11px] font-semibold tracking-widest uppercase text-[#8a6a5a] mb-1">
            Axis 2 — Domain representation
          </p>
          <p className="text-sm text-[#572020] leading-relaxed">
            Is the question's topic represented in your approved corpus? High
            representation means the retrieval step found a close match among
            your approved sources. Low representation signals a coverage gap
            that only you can close by approving new interpretations.
          </p>
        </div>
      </div>

      {/* Three zones */}
      <p className="text-[11px] font-semibold tracking-widest uppercase text-[#8a6a5a] mb-3">
        Three zones
      </p>
      <div className="space-y-3 mb-5">
        {/* Zone 1 — AI Assisted */}
        <div className="rounded-xl border border-green-200 bg-green-50 p-4">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="w-2 h-2 rounded-full bg-green-600 flex-shrink-0" />
            <span className="text-[11px] font-semibold tracking-widest uppercase text-green-800">
              Zone 1 · AI Assisted
            </span>
            <span className="ml-auto text-[11px] text-green-700 font-medium">
              High representation · reversible
            </span>
          </div>
          <p className="text-sm text-green-900 leading-relaxed">
            The question matched an approved interpretation and the citation
            guard independently verified the source. Visitors see your name and
            the verified citation. <strong>No action needed.</strong>
          </p>
        </div>

        {/* Zone 2 — AI Informed */}
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0" />
            <span className="text-[11px] font-semibold tracking-widest uppercase text-amber-800">
              Zone 2 · AI Informed
            </span>
            <span className="ml-auto text-[11px] text-amber-700 font-medium">
              Low representation or unverified · reversible
            </span>
          </div>
          <p className="text-sm text-amber-900 leading-relaxed">
            The question fell in a coverage gap or the citation could not be
            verified against retrieved sources. The answer is queued in your
            Source Review inbox. <strong>Approve interpretations</strong> for
            the gap topic and future asks shift to Zone 1 automatically.
          </p>
        </div>

        {/* Zone 3 — Manual sign-off required */}
        <div className="rounded-xl border border-[#E8DDD0] bg-white p-4">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="w-2 h-2 rounded-full bg-[#8a6a5a] flex-shrink-0" />
            <span className="text-[11px] font-semibold tracking-widest uppercase text-[#8a6a5a]">
              Zone 3 · Manual sign-off required
            </span>
            <span className="ml-auto text-[11px] text-[#8a6a5a] font-medium">
              High cost · structurally off-domain
            </span>
          </div>
          <p className="text-sm text-[#572020] leading-relaxed">
            The question is refused (out of your pillar's domain) or requires
            clinical judgment beyond the agent's scope. These are not coverage
            gaps — they are domain boundaries. Resolution requires a
            <strong> manual reply</strong> from you via the Support Handoff
            queue, not a corpus addition.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-[#E8DDD0] bg-[#FBF7F0] p-4">
        <p className="text-[11px] font-semibold tracking-widest uppercase text-[#8a6a5a] mb-2">
          Moving questions from Zone 2 → Zone 1
        </p>
        <ol className="space-y-1 text-sm text-[#572020] list-none">
          <li className="flex gap-2">
            <span className="text-[#8C1515] font-semibold flex-shrink-0">
              1.
            </span>
            <span>
              Open <strong>Source Review</strong> and approve interpretations
              covering the gap topic.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-[#8C1515] font-semibold flex-shrink-0">
              2.
            </span>
            <span>The engine re-indexes approved content automatically.</span>
          </li>
          <li className="flex gap-2">
            <span className="text-[#8C1515] font-semibold flex-shrink-0">
              3.
            </span>
            <span>
              The next similar question receives an{" "}
              <strong className="text-green-700">AI Assisted</strong> badge with
              your name attached.
            </span>
          </li>
        </ol>
      </div>
    </section>
  );
}

interface SupportHandoffItem {
  id: number;
  source: "ask" | "uncovered";
  askerName: string | null;
  askerEmail: string | null;
  message: string;
  suggestedPillarName: string | null;
  draftReply: string | null;
  sourceContext:
    | { marker?: string; citation?: string; title?: string }[]
    | null;
  createdAt: string;
}

/**
 * Support concierge handoff. When a support agent routes a reader question to
 * the steward who knows it best, it lands here so the steward can answer it in
 * their own voice (the support pre-drafted reply is editable). Sending closes
 * the item and emails the asker (when there is one). Renders nothing when the
 * steward's queue is empty.
 */
function SupportHandoffCard({
  item,
  onSent,
}: {
  item: SupportHandoffItem;
  onSent: () => void;
}) {
  const [reply, setReply] = useState(item.draftReply ?? "");
  const send = useMutation({
    mutationFn: () =>
      fetchJson(`/api/support/steward/questions/${item.id}/send`, {
        method: "POST",
        body: JSON.stringify({ reply: reply.trim() }),
      }),
    onSuccess: () => onSent(),
  });

  return (
    <div className="rounded-lg border border-[#E8DDD0] bg-white p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] tracking-[0.16em] uppercase font-semibold text-[#8C1515] border border-[#8C1515] rounded-full px-2 py-[1px]">
          {item.source === "ask" ? "Ask Stanford" : "Uncovered"}
        </span>
        {item.suggestedPillarName && (
          <span className="text-xs text-[#8a6a5a]">
            {item.suggestedPillarName}
          </span>
        )}
      </div>
      <p className="font-serif text-[#572020] text-lg leading-snug mb-1">
        {item.message}
      </p>
      <div className="text-xs text-[#8a6a5a] mb-3">
        {item.askerEmail
          ? `From ${item.askerName ? `${item.askerName} · ` : ""}${item.askerEmail}`
          : "Anonymous (asked an AI agent)"}
      </div>
      {item.sourceContext && item.sourceContext.length > 0 && (
        <div className="rounded-md bg-[#FBF7F0] border border-[#E8DDD0] p-3 mb-3 text-xs text-[#572020]">
          <div className="uppercase tracking-[0.1em] text-[#8a6a5a] font-semibold mb-1 text-[10px]">
            Source context
          </div>
          {item.sourceContext.map((s, i) => (
            <div key={i}>{s.citation ?? s.title ?? s.marker ?? "—"}</div>
          ))}
        </div>
      )}
      <textarea
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        rows={4}
        placeholder="Answer in your own voice…"
        className="w-full rounded-md border border-[#E8DDD0] p-3 text-sm text-[#572020] bg-white resize-y focus:outline-none focus:border-[#8C1515]"
      />
      <div className="flex items-center gap-3 mt-3">
        <button
          onClick={() => send.mutate()}
          disabled={send.isPending || !reply.trim()}
          className="bg-[#8C1515] hover:bg-[#a01a1a] disabled:opacity-50 text-white text-sm font-semibold rounded-full px-5 py-2"
        >
          {send.isPending ? "Sending…" : "Send in my voice"}
        </button>
        {send.isError && (
          <span className="text-xs text-[#E8352A]">
            {(send.error as Error).message}
          </span>
        )}
      </div>
    </div>
  );
}

function SupportHandoffPanel() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<{ items: SupportHandoffItem[] }>({
    queryKey: ["support-steward-queue"],
    queryFn: () => fetchJson("/api/support/steward/queue"),
  });

  if (isLoading || error || !data) return null;
  if (data.items.length === 0) return null;

  return (
    <section
      className="mb-10 border border-[#E8DDD0] rounded-xl p-6 bg-white/40"
      data-testid="panel-support-handoff"
    >
      <div className="mb-4">
        <SectionEyebrow
          icon={<IconPulse />}
          label="From the concierge"
          tone="cardinal"
        />
        <h2 className="font-serif text-lg text-[#572020]">
          {data.items.length === 1
            ? "A reply is waiting for you"
            : `${data.items.length} replies are waiting for you`}
        </h2>
        <p className="text-sm text-[#8a6a5a] mt-1">
          Support routed these reader questions to you. Answer in your own voice
          — your edit is what gets sent.
        </p>
      </div>
      <div className="space-y-4">
        {data.items.map((item) => (
          <SupportHandoffCard
            key={item.id}
            item={item}
            onSent={() =>
              qc.invalidateQueries({ queryKey: ["support-steward-queue"] })
            }
          />
        ))}
      </div>
    </section>
  );
}

// Impact-first welcome for a freshly admitted applicant: the questions people
// are already asking in their field and the gaps their pillar could fill.
// Dismissible; built entirely from existing query/insights data.
function ImpactWelcome({
  slug,
  pillarName,
}: {
  slug: string;
  pillarName: string;
}) {
  const dismissKey = `palonur_impact_welcome_${slug}`;
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(dismissKey) === "1",
  );
  const { data } = useQuery<{
    windowDays: number;
    totalQuestions: number;
    uncoveredQuestions: number;
    exampleGaps: Array<{ question: string; count: number }>;
  }>({
    queryKey: ["faculty-pillar-impact", slug],
    queryFn: () => fetchJson(`/api/faculty/pillars/${slug}/impact`),
    enabled: !dismissed,
  });
  if (dismissed || !data) return null;
  return (
    <div
      className="mb-8 rounded-2xl border border-[#E8DDD0] bg-[#F7F0E4] p-6"
      data-testid="card-impact-welcome"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-2">
            Welcome to {pillarName}
          </p>
          <h2 className="font-serif text-2xl font-medium mb-2">
            People are already asking for you.
          </h2>
          <p className="text-[#8a6a5a] leading-relaxed mb-4 max-w-2xl">
            In the last {data.windowDays} days, readers asked{" "}
            <strong data-testid="text-impact-total">
              {data.totalQuestions}
            </strong>{" "}
            questions in your field.{" "}
            {data.uncoveredQuestions > 0 ? (
              <>
                <strong data-testid="text-impact-uncovered">
                  {data.uncoveredQuestions}
                </strong>{" "}
                of them could not be answered yet. That is where your expertise
                comes in.
              </>
            ) : (
              <>Your pillar is off to a strong start.</>
            )}
          </p>
          {data.exampleGaps.length > 0 && (
            <ul className="space-y-1 text-sm text-[#572020]">
              {data.exampleGaps.slice(0, 3).map((g, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-[#8C1515]">•</span>
                  <span>{g.question}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          onClick={() => {
            localStorage.setItem(dismissKey, "1");
            setDismissed(true);
          }}
          className="text-[#8a6a5a] hover:text-[#572020] text-sm shrink-0"
          data-testid="button-dismiss-impact"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function Dashboard() {
  const { data, isLoading, error } = useMe();
  const { user } = useUser();
  const viewAs = useViewAs();
  const isAllison = useIsAllisonView(user?.primaryEmailAddress?.emailAddress);
  // Trimmed ASLM view (real aslm-channel members AND anyone who entered via
  // /faculty/?aslm=1): the dashboard keeps only the greeting + workspace card.
  const aslm = isAslmMember(data) || isAslmEntry();
  if (isLoading)
    return (
      <PortalShell>
        <p className="text-[#8a6a5a]">Loading…</p>
      </PortalShell>
    );
  if (error)
    return (
      <PortalShell>
        <p className="text-[#E8352A]" data-testid="text-error">
          {(error as Error).message}
        </p>
      </PortalShell>
    );
  if (!data) return null;

  if (data.awaitingInvitation) {
    return <Redirect to="/awaiting-invite" />;
  }

  // Archived members still have an active Clerk account but their portal is
  // suspended. Show a neutral "on leave" screen instead of the dashboard.
  if (data.archived && !viewAs) {
    return (
      <PortalShell>
        <div className="max-w-xl mx-auto py-20 px-6 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-[#F3E9D8] mb-6">
            <IconInbox />
          </div>
          <h1 className="font-serif text-3xl mb-3 text-[#572020]">
            Your account is on leave
          </h1>
          <p className="text-[#8a6a5a] leading-relaxed mb-6">
            Your steward access has been temporarily suspended. Your published
            content and contributions remain live. Contact the Stanford team to
            restore your access.
          </p>
          <a
            href="mailto:karan@stanford.edu"
            className="inline-block bg-[#8C1515] text-white px-6 py-3 rounded-xl text-sm font-medium hover:bg-[#a01a1a] transition"
          >
            Contact the Stanford team
          </a>
        </div>
      </PortalShell>
    );
  }

  // When an admin is previewing a member ("Preview dashboard"), always render
  // the real portal even if that member hasn't onboarded yet. The welcome story
  // is identical for every steward, so previewing it adds no signal — the admin
  // wants to see the member's actual, pillar/role-specific dashboard.
  if (!data.onboarded && !viewAs) {
    return <Redirect to="/welcome" />;
  }

  // Pick the pillar the "Manage your knowledge" path links to: prefer a pillar
  // the member stewards, else the first they belong to, else the first listed.
  const myPillars = data.pillars.filter((p) =>
    data.memberships.some((m) => m.pillarId === p.id),
  );
  const stewardPillar = data.pillars.find((p) =>
    data.memberships.some((m) => m.pillarId === p.id && m.role === "steward"),
  );
  const primaryPillar =
    stewardPillar ?? myPillars[0] ?? data.pillars[0] ?? null;
  const pillarChoiceCount = myPillars.length || data.pillars.length;

  // Brand the greeting with the steward's pillar logo. Resolved from the pillar they
  // steward; null for any other pillar leaves the dashboard unbranded.
  const dashboardLogo = stewardPillar ? pillarLogo(stewardPillar.slug) : null;

  const firstName =
    data.user.fullName?.trim().split(/\s+/)[0] || user?.firstName || null;
  // A steward whose pillar isn't part of the Stanford roster gets the warm
  // belonging welcome instead of the generic playful one.
  const nonStanfordStewardPillar = data.pillars.find(
    (p) =>
      NON_STANFORD_PILLARS.has(p.slug) &&
      data.memberships.some((m) => m.pillarId === p.id && m.role === "steward"),
  );

  // The dashboard is a lean launcher: greet the steward, then offer exactly one
  // of three jobs (build the library with your team · answer uncovered reader
  // questions · distribute), each wired to the surface that already does it.
  // The first-login welcome story still runs separately at /welcome.

  return (
    <PortalShell>
      {dashboardLogo && <DashboardPillarLogo logo={dashboardLogo} />}
      {isAllison ? (
        <AllisonGreeting />
      ) : nonStanfordStewardPillar ? (
        <BeyondStanfordWelcome
          firstName={firstName}
          pillarName={nonStanfordStewardPillar.name}
        />
      ) : (
        <FunGreeting firstName={firstName} />
      )}
      {data.application?.status === "admitted" && primaryPillar && !aslm && (
        <ImpactWelcome
          slug={primaryPillar.slug}
          pillarName={primaryPillar.name}
        />
      )}
      {data.user.isPlatformAdmin && <AdminSourceManagerPanel />}
      {stewardPillar && !aslm && <SupportHandoffPanel />}
      {stewardPillar && !aslm && <ResearchValidationCard />}
      {stewardPillar ? (
        <StewardProcesses
          slug={stewardPillar.slug}
          pillarName={stewardPillar.name}
          isLM={SLM_PILLAR_SLUGS.has(stewardPillar.slug)}
          aslm={aslm}
        />
      ) : myPillars.length === 0 ? (
        // Platform admin / operator with no pillar membership: the steward
        // "your pillar" card has nowhere to go, so show the admin hub instead
        // of a dead card. (A non-admin with no membership is redirected to
        // /awaiting-invite above, so this branch is always a platform admin.)
        <AdminHubPanel />
      ) : (
        // Non-steward members (viewer/contributor/advisor) keep the simple hub.
        <TwoPathsPanel
          pillarSlug={primaryPillar?.slug ?? null}
          multiPillar={pillarChoiceCount > 1}
        />
      )}
      {pillarChoiceCount > 1 && (
        <>
          <div id="your-pillars" className="scroll-mt-24" />
          <SectionEyebrow icon={<IconCompass />} label="Your workspace" />
          <h1 className="font-serif text-3xl font-medium mb-2">Your pillars</h1>
          <p className="text-[#8a6a5a] mb-8">
            Each pillar is a domain you steward, contribute to, or view.
          </p>
          <div className="grid gap-5 md:grid-cols-2">
            {(() => {
              const pillars = data.pillars;
              const memberships = data.memberships;
              return pillars.map((p) => {
                const m = memberships.find((m) => m.pillarId === p.id);
                const role = m?.role ?? "admin";
                const isSteward = role === "steward";
                const lead = p.stewards[0] ?? null;
                return (
                  <Link
                    key={p.id}
                    href={`/pillars/${p.slug}`}
                    className="group block overflow-hidden rounded-2xl border border-[#E8DDD0] bg-white/50 transition hover:border-[#8C1515] hover:shadow-md"
                    data-testid={`link-pillar-${p.slug}`}
                  >
                    {/* Warm campus + topic illustration header band */}
                    <div className="relative h-32 overflow-hidden bg-gray-100">
                      <img
                        src={pillarCardArt(p.slug)}
                        alt=""
                        aria-hidden
                        className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]"
                      />
                      <span
                        className={`absolute top-3 right-3 rounded-full px-2.5 py-1 text-[10px] font-medium tracking-[0.16em] uppercase backdrop-blur-sm ${
                          isSteward
                            ? "bg-[#8C1515] text-white"
                            : "bg-white/85 text-[#8C1515]"
                        }`}
                      >
                        {role}
                      </span>
                      {lead && (
                        <span className="absolute -bottom-7 left-5">
                          <StewardAvatar
                            name={lead.name}
                            photoUrl={lead.photoUrl}
                            size={56}
                          />
                        </span>
                      )}
                    </div>
                    <div className={`p-5 ${lead ? "pt-9" : "pt-5"}`}>
                      <h2 className="font-serif text-xl text-[#572020] truncate">
                        {p.name}
                      </h2>
                      {lead?.name && (
                        <p
                          className="text-xs text-[#8a6a5a] mb-1"
                          data-testid={`pillar-steward-${p.slug}`}
                        >
                          Stewarded by{" "}
                          <span className="text-[#572020]">{lead.name}</span>
                          {p.stewards.length > 1 &&
                            ` +${p.stewards.length - 1} more`}
                        </p>
                      )}
                      {p.description && (
                        <p className="text-sm text-[#8a6a5a] leading-relaxed mt-1">
                          {p.description}
                        </p>
                      )}
                      <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[#8C1515] opacity-0 transition group-hover:opacity-100">
                        Open pillar →
                      </span>
                    </div>
                  </Link>
                );
              });
            })()}
          </div>
        </>
      )}
      {!aslm && <MyFrameworkBookingsCard />}
    </PortalShell>
  );
}

interface FacultyOffer {
  id: number;
  title: string;
  summary: string | null;
  status: "offered" | "accepted" | "declined";
  declineReason: string | null;
  createdAt: string;
}

interface CommunicationOffer {
  id: number;
  title: string;
  summary: string | null;
  status: "offered" | "accepted" | "declined";
  reviewerNote: string | null;
  createdAt: string;
}

interface ParentDataOffer {
  id: number;
  title: string;
  summary: string | null;
  callId: number | null;
  status: "offered" | "accepted" | "declined";
  reviewerNote: string | null;
  paymentCents: number | null;
  createdAt: string;
}

interface ParentDataCall {
  id: number;
  title: string;
  brief: string | null;
  budgetCents: number | null;
  status: "open" | "closed";
  createdAt: string;
}

// Payment/budget are record-only — never a real charge. Cents → "$1,250".
function formatParentDataMoney(cents: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

interface ParentDataMessage {
  id: number;
  offerId: number;
  senderRole: "faculty" | "reviewer";
  senderName: string | null;
  body: string;
  createdAt: string;
}

// ParentData stores offered/accepted/declined; the steward reads it as the
// editor's review state.
const parentDataStatusLabel: Record<ParentDataOffer["status"], string> = {
  offered: "Pending",
  accepted: "Approved",
  declined: "Declined",
};

// A back-and-forth conversation on a single ParentData proposal, shared between
// the steward (here) and ParentData's editor (in her own dashboard). Messages
// are rendered as escaped text — never HTML — so a reply can't inject script.
function ParentDataOfferThread({ offerId }: { offerId: number }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const messagesQuery = useQuery<{ messages: ParentDataMessage[] }>({
    queryKey: ["faculty-parentdata-messages", offerId],
    queryFn: () =>
      fetchJson(`/api/faculty/parentdata-offers/${offerId}/messages`),
  });
  const sendMessage = useMutation({
    mutationFn: () =>
      fetchJson(`/api/faculty/parentdata-offers/${offerId}/messages`, {
        method: "POST",
        body: JSON.stringify({ body: draft.trim() }),
      }),
    onSuccess: () => {
      setDraft("");
      qc.invalidateQueries({
        queryKey: ["faculty-parentdata-messages", offerId],
      });
    },
  });
  const messages = messagesQuery.data?.messages ?? [];
  return (
    <div className="mt-3 border-t border-[#E8DDD0] pt-3">
      <div className="text-[10px] tracking-[0.15em] uppercase text-[#0E7C7B] font-semibold mb-2">
        Conversation with ParentData
      </div>
      <div
        className="space-y-2 max-h-64 overflow-y-auto pr-1"
        data-testid={`parentdata-thread-${offerId}`}
      >
        {messagesQuery.isLoading ? (
          <p className="text-[#8a6a5a] text-sm">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="text-[#8a6a5a] text-sm">
            No messages yet. Start a conversation with the editor below.
          </p>
        ) : (
          messages.map((m) => {
            const mine = m.senderRole === "faculty";
            return (
              <div
                key={m.id}
                className={`max-w-[85%] rounded-xl px-3 py-2 ${
                  mine
                    ? "ml-auto bg-[#0E7C7B] text-white"
                    : "mr-auto bg-[#F1EEE8] text-[#572020]"
                }`}
                data-testid={`parentdata-message-${m.id}`}
              >
                <div
                  className={`text-[10px] mb-1 font-semibold ${mine ? "text-white/80" : "text-[#8a6a5a]"}`}
                >
                  {mine ? "You" : (m.senderName ?? "ParentData editor")} ·{" "}
                  {new Date(m.createdAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </div>
                <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                  {m.body}
                </div>
              </div>
            );
          })
        )}
      </div>
      <div className="mt-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message the ParentData editor…"
          rows={2}
          className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 bg-white text-[#572020] placeholder:text-[#b39b8c] focus:outline-none focus:ring-2 focus:ring-[#0E7C7B]/30"
          data-testid={`parentdata-message-input-${offerId}`}
        />
        {sendMessage.isError && (
          <p className="text-sm text-[#8C1515] mt-1">
            Couldn't send — try again.
          </p>
        )}
        <button
          onClick={() => sendMessage.mutate()}
          disabled={!draft.trim() || sendMessage.isPending}
          className="mt-2 bg-[#0E7C7B] hover:bg-[#0a5c5b] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
          data-testid={`parentdata-message-send-${offerId}`}
        >
          {sendMessage.isPending ? "Sending…" : "Send message"}
        </button>
      </div>
    </div>
  );
}

interface FacultyCredit {
  id: number;
  postTitle: string | null;
  issueId: number;
  amountCents: number;
  status: "pending" | "approved" | "paid";
  createdAt: string;
}

interface FacultyCreditsResponse {
  credits: FacultyCredit[];
  summary: {
    featuredCount: number;
    totalCents: number;
    paidCents: number;
    outstandingCents: number;
  };
}

const offerStatusStyle: Record<FacultyOffer["status"], string> = {
  offered: "bg-[#F3E9D8] text-[#8a6a5a]",
  accepted: "bg-[#E3F0E3] text-[#2f6b3a]",
  declined: "bg-[#F3E0DE] text-[#8C1515]",
};

const creditStatusStyle: Record<FacultyCredit["status"], string> = {
  pending: "bg-[#F3E9D8] text-[#8a6a5a]",
  approved: "bg-[#E6ECF6] text-[#2a4d8f]",
  paid: "bg-[#E3F0E3] text-[#2f6b3a]",
};

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// Back link shown at the top of each per-outlet detail view, returning the
// steward to the channel grid.
function ChannelDetailBack({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-[#8C1515] transition hover:gap-2.5"
      data-testid="button-back-to-channels"
    >
      <span aria-hidden>←</span> All distribution channels
    </button>
  );
}

function FacultyNewsletter() {
  const { data: me, isLoading: meLoading } = useMe();
  const qc = useQueryClient();
  // First pillar the contributor stewards — the BOOKER pillar when applying a
  // colleague's framework to a draft here.
  const bookerPillarId = useMemo(() => {
    const m = me?.memberships.find((mm) => mm.role === "steward");
    return m?.pillarId;
  }, [me]);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [institution, setInstitution] = useState("");
  const [institutionEdited, setInstitutionEdited] = useState(false);
  const [institutionMsg, setInstitutionMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Master/detail: the channel showcase is the landing; clicking an offer
  // outlet's card swaps in that outlet's dedicated view (no scrolling). null =
  // the channel grid is showing.
  const [activeOutlet, setActiveOutlet] = useState<
    null | "newsletter" | "matt" | "parentdata"
  >(null);

  // Seed the institution field from the loaded profile (once, until the user
  // starts editing it).
  useEffect(() => {
    if (me && !institutionEdited) {
      setInstitution(me.user.institution ?? "");
    }
  }, [me, institutionEdited]);

  const saveInstitution = useMutation({
    mutationFn: () =>
      fetchJson<{ institution: string | null }>("/api/faculty/me", {
        method: "PATCH",
        body: JSON.stringify({ institution: institution.trim() }),
      }),
    onSuccess: () => {
      setInstitutionMsg("Saved.");
      setInstitutionEdited(false);
      qc.invalidateQueries({ queryKey: ["faculty-me"] });
    },
    onError: (e) => setInstitutionMsg((e as Error).message),
  });

  const savePhoto = useMutation({
    mutationFn: (photoUrl: string | null) =>
      fetchJson<{ photoUrl: string | null }>("/api/faculty/me", {
        method: "PATCH",
        body: JSON.stringify({ photoUrl: photoUrl ?? "" }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["faculty-me"] }),
  });

  const offersQuery = useQuery<{ offers: FacultyOffer[] }>({
    queryKey: ["faculty-newsletter-offers"],
    queryFn: () => fetchJson("/api/faculty/newsletter-offers"),
    enabled: !!me && !me.awaitingInvitation,
  });
  const pubQuery = useQuery<{ publication: FacultyPublication }>({
    queryKey: ["faculty-publication"],
    queryFn: () => fetchJson("/api/faculty/publication"),
    enabled: !!me && !me.awaitingInvitation,
  });
  const subsQuery = useQuery<{
    subscribers: PubSubscriber[];
    counts: { total: number; active: number; unsubscribed: number };
  }>({
    queryKey: ["faculty-pub-subscribers"],
    queryFn: () => fetchJson("/api/faculty/publication/subscribers"),
    enabled: !!me && !me.awaitingInvitation,
  });
  const issuesQuery = useQuery<{ issues: PubIssue[] }>({
    queryKey: ["faculty-pub-issues"],
    queryFn: () => fetchJson("/api/faculty/publication/issues"),
    enabled: !!me && !me.awaitingInvitation,
  });
  const channelInterestQuery = useQuery<{ channelKeys: string[] }>({
    queryKey: ["faculty-channel-interest"],
    queryFn: () => fetchJson("/api/faculty/channel-interest"),
    enabled: !!me && !me.awaitingInvitation,
  });
  // The Distribution Channels cards are DB-backed (admin-managed). The render
  // branches on each channel's fields exactly as before; only the source moved
  // from a hardcoded array to this query.
  const channelsQuery = useQuery<{ channels: DistributionChannel[] }>({
    queryKey: ["faculty-distribution-channels"],
    queryFn: () => fetchJson("/api/faculty/distribution-channels"),
    enabled: !!me && !me.awaitingInvitation,
  });
  const registerInterest = useMutation({
    mutationFn: (channelKey: string) =>
      fetchJson("/api/faculty/channel-interest", {
        method: "POST",
        body: JSON.stringify({ channelKey }),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["faculty-channel-interest"] }),
  });

  const createOffer = useMutation({
    mutationFn: () =>
      fetchJson("/api/faculty/newsletter-offers", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          summary: summary.trim() || undefined,
          bodyHtml: bodyHtml.trim() || undefined,
        }),
      }),
    onSuccess: () => {
      setTitle("");
      setSummary("");
      setBodyHtml("");
      qc.invalidateQueries({ queryKey: ["faculty-newsletter-offers"] });
    },
  });

  // ── Offer to Matt (communication-angle articles) ──────────────────────────
  // Temporarily marked "coming soon": Matt Abrahams isn't reviewing offers yet,
  // so the submission path is disabled (and badged "Soon") for the time being.
  const mattComingSoon = true;
  const [mattTitle, setMattTitle] = useState("");
  const [mattSummary, setMattSummary] = useState("");
  const [mattBody, setMattBody] = useState("");

  const mattOffersQuery = useQuery<{ offers: CommunicationOffer[] }>({
    queryKey: ["faculty-communication-offers"],
    queryFn: () => fetchJson("/api/faculty/communication-offers"),
    enabled: !!me && !me.awaitingInvitation,
  });

  const createMattOffer = useMutation({
    mutationFn: () =>
      fetchJson("/api/faculty/communication-offers", {
        method: "POST",
        body: JSON.stringify({
          title: mattTitle.trim(),
          summary: mattSummary.trim() || undefined,
          bodyHtml: mattBody.trim() || undefined,
        }),
      }),
    onSuccess: () => {
      setMattTitle("");
      setMattSummary("");
      setMattBody("");
      qc.invalidateQueries({ queryKey: ["faculty-communication-offers"] });
    },
  });

  // ── Offer an article to ParentData.org ────────────────────────────────────
  // A live channel: proposals go to ParentData's editor's own review queue, with
  // a back-and-forth conversation on each. No SLM newsletter, no reimbursement.
  const [pdTitle, setPdTitle] = useState("");
  const [pdSummary, setPdSummary] = useState("");
  const [pdBody, setPdBody] = useState("");
  // "" = an unsolicited pitch; a numeric id = answering a specific open call.
  const [pdCallId, setPdCallId] = useState("");

  const parentDataOffersQuery = useQuery<{ offers: ParentDataOffer[] }>({
    queryKey: ["faculty-parentdata-offers"],
    queryFn: () => fetchJson("/api/faculty/parentdata-offers"),
    enabled: !!me && !me.awaitingInvitation,
  });

  const parentDataCallsQuery = useQuery<{ calls: ParentDataCall[] }>({
    queryKey: ["faculty-parentdata-calls"],
    queryFn: () => fetchJson("/api/faculty/parentdata-calls"),
    enabled: !!me && !me.awaitingInvitation,
  });

  const parentDataCalls = parentDataCallsQuery.data?.calls ?? [];
  const parentDataCallById = new Map(parentDataCalls.map((c) => [c.id, c]));

  const createParentDataOffer = useMutation({
    mutationFn: () =>
      fetchJson("/api/faculty/parentdata-offers", {
        method: "POST",
        body: JSON.stringify({
          title: pdTitle.trim(),
          summary: pdSummary.trim() || undefined,
          bodyHtml: pdBody.trim() || undefined,
          callId: pdCallId ? Number(pdCallId) : undefined,
        }),
      }),
    onSuccess: () => {
      setPdTitle("");
      setPdSummary("");
      setPdBody("");
      setPdCallId("");
      qc.invalidateQueries({ queryKey: ["faculty-parentdata-offers"] });
    },
  });

  if (meLoading)
    return (
      <PortalShell>
        <p className="text-[#8a6a5a]">Loading…</p>
      </PortalShell>
    );
  if (me && me.awaitingInvitation) return <Redirect to="/awaiting-invite" />;

  const canSubmit = title.trim().length > 0 && !createOffer.isPending;

  const pub = pubQuery.data?.publication;
  const ownPublicUrl = pub ? `${publicOrigin()}/p/${pub.slug}` : "";
  const ownActiveSubs = subsQuery.data?.counts.active ?? 0;
  const ownSentIssues = (issuesQuery.data?.issues ?? []).filter(
    (i) => i.status === "sent",
  );
  const ownSentDates = ownSentIssues
    .map((i) => i.sentAt)
    .filter((d): d is string => !!d)
    .sort();
  const ownLastSentAt =
    ownSentDates.length > 0 ? ownSentDates[ownSentDates.length - 1] : undefined;

  const channels = channelsQuery.data?.channels ?? [];

  const StatusBadge = ({ status }: { status: "live" | "soon" }) =>
    status === "live" ? (
      <span className="text-[10px] tracking-[0.15em] uppercase px-2 py-1 rounded bg-[#8C1515]/10 text-[#8C1515]">
        Live
      </span>
    ) : (
      <span className="text-[10px] tracking-[0.15em] uppercase px-2 py-1 rounded bg-[#E8DDD0] text-[#8a6a5a]">
        Soon
      </span>
    );

  return (
    <PortalShell>
      {/* Distribution Channels — the master grid; each offer outlet's card
          swaps in its own detail view below instead of scrolling. */}
      {activeOutlet === null && (
        <section className="mb-10">
          <p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-3">
            Distribution Channels
          </p>
          <h1 className="font-serif text-3xl md:text-4xl font-medium mb-3">
            Where your vetted voice lands
          </h1>
          <p className="text-[#8a6a5a] mb-8 max-w-2xl leading-relaxed">
            The newsletter is one of many channels carrying your expertise to
            readers — alongside podcasts, major magazines, and national news
            outlets. Here's the full set, live today and coming soon. The
            newsletter is where you offer pieces; the rest are reach.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {channels.map((c) => {
              const inner = (
                <>
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="min-w-0">
                      <p className="text-[10px] tracking-[0.15em] uppercase text-[#a08c7c] mb-1">
                        {c.category}
                      </p>
                      <h3 className="font-serif text-lg text-[#572020] leading-snug">
                        {c.name}
                      </h3>
                    </div>
                    <span className="flex-none mt-0.5">
                      <StatusBadge status={c.status} />
                    </span>
                  </div>
                  <p className="text-sm text-[#8a6a5a] leading-relaxed">
                    {c.description}
                  </p>
                  {c.href && (
                    <span className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-[#8C1515]">
                      Visit
                      <span className="transition group-hover:translate-x-0.5">
                        →
                      </span>
                    </span>
                  )}
                  {c.outlet && (
                    <span className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-[#8C1515]">
                      {c.status === "soon" ? "Preview" : "Open"}
                      <span className="transition group-hover:translate-x-0.5">
                        →
                      </span>
                    </span>
                  )}
                </>
              );
              const baseCard = "flex flex-col rounded-xl border p-5 transition";
              if (c.outlet) {
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setActiveOutlet(c.outlet!)}
                    className={`group ${baseCard} text-left ${
                      c.isPrimary
                        ? "border-[#8C1515] bg-white/80 shadow-sm hover:bg-white"
                        : "border-[#E8DDD0] bg-white/50 hover:border-[#8C1515] hover:bg-white/80 hover:shadow-sm"
                    }`}
                    data-testid={`channel-outlet-${c.outlet}`}
                  >
                    {inner}
                  </button>
                );
              }
              if (c.status === "soon") {
                const interested =
                  !!c.key &&
                  (channelInterestQuery.data?.channelKeys.includes(c.key) ??
                    false);
                return (
                  <div
                    key={c.id}
                    className={`${baseCard} border-[#E8DDD0] bg-[#FBF7F0]`}
                    data-testid={`channel-${c.status}`}
                  >
                    {/* The descriptive content is dimmed (channel isn't live yet),
                      but the interest action stays at full opacity so stewards
                      can opt in. */}
                    <div className="opacity-60">{inner}</div>
                    {c.key &&
                      (interested ? (
                        <span
                          className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-[#2f6b3a]"
                          data-testid={`channel-interested-${c.key}`}
                        >
                          ✓ We'll notify you
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => registerInterest.mutate(c.key!)}
                          disabled={registerInterest.isPending}
                          className="mt-3 w-fit text-sm font-medium text-[#8C1515] underline hover:no-underline disabled:opacity-50"
                          data-testid={`button-notify-${c.key}`}
                        >
                          {registerInterest.isPending &&
                          registerInterest.variables === c.key
                            ? "Saving…"
                            : "Notify me when this opens"}
                        </button>
                      ))}
                  </div>
                );
              }
              if (c.href) {
                return (
                  <a
                    key={c.id}
                    href={c.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`group ${baseCard} border-[#E8DDD0] bg-white/50 hover:border-[#8C1515] hover:bg-white/80 hover:shadow-sm`}
                    data-testid="channel-live"
                  >
                    {inner}
                  </a>
                );
              }
              // Every channel is an outlet, an external link, or "soon"; nothing
              // reaches here.
              return null;
            })}
          </div>
        </section>
      )}

      {/* ── Newsletter outlet — the SLM house newsletter + the steward's own ── */}
      {activeOutlet === "newsletter" && (
        <>
          <ChannelDetailBack onBack={() => setActiveOutlet(null)} />

          {/* Your own newsletter — the one channel a steward fully owns */}
          <section
            className="mb-12 rounded-2xl border border-[#8C1515]/25 bg-gradient-to-br from-[#F9F5EE] to-[#F4ECDD] p-6 md:p-8"
            data-testid="section-your-own-newsletter"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-xl">
                <p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-2">
                  Your own channel
                </p>
                <h2 className="font-serif text-2xl md:text-3xl font-medium mb-2">
                  {pub?.name || "Your own newsletter"}
                </h2>
                <p className="text-[#7a5a4a] leading-relaxed">
                  The one channel you fully own — your subscribers, your
                  branding, your byline. Hosted and sent by the platform, and
                  entirely separate from the Stanford Lifestyle Medicine house
                  newsletter below.
                </p>
              </div>
              <Link
                href="/my-newsletter"
                className="inline-flex items-center gap-2 rounded-lg bg-[#8C1515] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#a01a1a]"
                data-testid="link-manage-my-newsletter"
              >
                Manage your newsletter →
              </Link>
            </div>

            {pubQuery.isLoading ? (
              <p className="mt-6 text-[#8a6a5a]">Loading…</p>
            ) : !pub ? (
              <p className="mt-6 text-[#8a6a5a]">
                Couldn't load your newsletter.
              </p>
            ) : (
              <div className="mt-6 space-y-5">
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="rounded-xl border border-[#E8DDD0] bg-white/70 p-5">
                    <div
                      className="font-serif text-2xl"
                      data-testid="text-own-subscribers"
                    >
                      {ownActiveSubs}
                    </div>
                    <div className="mt-1 text-xs text-[#8a6a5a]">
                      Active subscribers
                    </div>
                  </div>
                  <div className="rounded-xl border border-[#E8DDD0] bg-white/70 p-5">
                    <div
                      className="font-serif text-2xl"
                      data-testid="text-own-issues-sent"
                    >
                      {ownSentIssues.length}
                    </div>
                    <div className="mt-1 text-xs text-[#8a6a5a]">
                      Issues sent
                    </div>
                  </div>
                  <div className="rounded-xl border border-[#E8DDD0] bg-white/70 p-5">
                    <div
                      className="font-serif text-2xl"
                      data-testid="text-own-last-sent"
                    >
                      {ownLastSentAt
                        ? new Date(ownLastSentAt).toLocaleDateString()
                        : "—"}
                    </div>
                    <div className="mt-1 text-xs text-[#8a6a5a]">
                      Last issue
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-[#E8DDD0] bg-white/60 p-5">
                  <p className="mb-2 text-sm font-medium text-[#572020]">
                    Your public signup page
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <a
                      href={ownPublicUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all text-[#8C1515] underline"
                      data-testid="link-own-public-signup"
                    >
                      {ownPublicUrl}
                    </a>
                    <button
                      onClick={() => {
                        void navigator.clipboard?.writeText(ownPublicUrl);
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 1500);
                      }}
                      className="rounded-lg border border-[#E8DDD0] bg-white px-3 py-1.5 text-xs font-medium text-[#572020] transition hover:border-[#8C1515]"
                      data-testid="button-copy-own-signup"
                    >
                      {copied ? "Copied!" : "Copy link"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>

          <div className="border-t border-[#E8DDD0] mb-10" />

          {/* Newsletter channel — what it is, for whom, the reach */}
          <section
            id="newsletter-channel"
            className="mb-12 grid gap-8 md:grid-cols-[1.45fr_1fr] md:items-center scroll-mt-24"
          >
            <div>
              <p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-3">
                Newsletter · Live channel
              </p>
              <h2 className="font-serif text-3xl md:text-4xl font-medium mb-5">
                Your science, in readers' inboxes
              </h2>
              <div className="space-y-4 max-w-xl">
                {[
                  {
                    icon: <IconBook />,
                    label: "What it is",
                    text: "Practical, evidence-based health guidance — written by Stanford faculty, one issue at a time.",
                  },
                  {
                    icon: <IconUsers />,
                    label: "Who it's for",
                    text: "People searching for answers they can trust — patients, athletes, older adults, clinicians, and the curious public.",
                  },
                  {
                    icon: <IconPulse />,
                    label: "Your reach",
                    text: "Straight to subscribers' inboxes — no feed, no algorithm. Every piece carries your byline.",
                  },
                ].map((row) => (
                  <div key={row.label} className="flex gap-3">
                    <span
                      className="flex-none inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[#8C1515]/8 text-[#8C1515]"
                      aria-hidden
                    >
                      {row.icon}
                    </span>
                    <p className="text-[#7a5a4a] leading-relaxed">
                      <span className="text-[#572020] font-medium">
                        {row.label}.
                      </span>{" "}
                      {row.text}
                    </p>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2 mt-6">
                {[
                  "General readers",
                  "Patients",
                  "Athletes",
                  "Older adults",
                  "Clinicians",
                  "Caregivers",
                ].map((seg) => (
                  <span
                    key={seg}
                    className="rounded-full border border-[#E8DDD0] bg-white/50 px-3 py-1 text-xs text-[#8a6a5a]"
                  >
                    {seg}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex justify-center">
              <div className="inline-flex h-48 w-48 items-center justify-center rounded-full border border-[#E8DDD0] bg-gradient-to-br from-[#F9F5EE] to-[#F4ECDD] shadow-sm">
                <img
                  src={illu("chapter-reach")}
                  alt=""
                  aria-hidden
                  loading="eager"
                  className="h-32 w-32 object-contain"
                />
              </div>
            </div>
          </section>

          <div className="border-t border-[#E8DDD0] mb-10" />

          <h2 className="font-serif text-2xl font-medium mb-2">
            Offer a post to the newsletter
          </h2>
          <p className="text-[#8a6a5a] mb-8 max-w-2xl leading-relaxed">
            Share a piece for the SLM newsletter. An editor reviews every offer
            before it runs, and published pieces carry your byline.
          </p>

          {/* Headshot */}
          <section className="border border-[#E8DDD0] rounded-xl p-6 mb-10">
            <h2 className="font-serif text-xl mb-1">Your photo</h2>
            <p className="text-sm text-[#8a6a5a] mb-4">
              Your headshot appears beside the pillars you steward. Upload a
              friendly face so collaborators recognize you.
            </p>
            <HeadshotField
              name={me?.user.fullName ?? null}
              photoUrl={me?.user.photoUrl ?? null}
              saving={savePhoto.isPending}
              onChange={(objectPath) => savePhoto.mutate(objectPath)}
            />
          </section>

          {/* Byline / institution */}
          <section className="border border-[#E8DDD0] rounded-xl p-6 mb-10">
            <h2 className="font-serif text-xl mb-1">Your byline</h2>
            <p className="text-sm text-[#8a6a5a] mb-4">
              Posts you contribute appear as{" "}
              <span className="text-[#572020]">
                By {me?.user.fullName || "Your name"}
                {institution.trim() ? ` · ${institution.trim()}` : ""}
              </span>
              . Add your institution to credit your home affiliation; leave it
              blank for a name-only byline.
            </p>
            <label className="block text-sm text-[#572020] mb-1">
              Institution
            </label>
            <div className="flex flex-col gap-2 max-w-lg sm:flex-row sm:items-center">
              <input
                value={institution}
                onChange={(e) => {
                  setInstitution(e.target.value);
                  setInstitutionEdited(true);
                  setInstitutionMsg(null);
                }}
                placeholder="e.g. Stanford Medicine"
                className="flex-1 border border-[#E8DDD0] rounded-lg px-3 py-2 bg-white focus:border-[#8C1515] outline-none"
                data-testid="input-my-institution"
              />
              <button
                onClick={() => saveInstitution.mutate()}
                disabled={
                  saveInstitution.isPending ||
                  institution.trim() === (me?.user.institution ?? "")
                }
                className="bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition disabled:opacity-40 w-fit"
                data-testid="button-save-institution"
              >
                {saveInstitution.isPending ? "Saving…" : "Save"}
              </button>
            </div>
            {institutionMsg && (
              <p
                className="text-xs text-[#8a6a5a] mt-2"
                data-testid="text-institution-msg"
              >
                {institutionMsg}
              </p>
            )}
          </section>

          {/* Offer form */}
          <section className="border border-[#E8DDD0] rounded-xl p-6 mb-10">
            <h2 className="font-serif text-xl mb-4">New offer</h2>
            <label className="block text-sm text-[#572020] mb-1">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Three ways to reset your circadian clock"
              className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 mb-4 bg-white focus:border-[#8C1515] outline-none"
              data-testid="input-offer-title"
            />
            <label className="block text-sm text-[#572020] mb-1">
              One-line summary <span className="text-[#a89] ">(optional)</span>
            </label>
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="What's the takeaway?"
              className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 mb-4 bg-white focus:border-[#8C1515] outline-none"
              data-testid="input-offer-summary"
            />
            <label className="block text-sm text-[#572020] mb-1">
              Draft / notes <span className="text-[#a89]">(optional)</span>
            </label>
            <textarea
              value={bodyHtml}
              onChange={(e) => setBodyHtml(e.target.value)}
              rows={6}
              placeholder="Paste a draft or the key points an editor can shape."
              className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 mb-4 bg-white focus:border-[#8C1515] outline-none"
              data-testid="input-offer-body"
            />
            {bookerPillarId !== undefined && (
              <FrameworkApplyPanel
                kind="article"
                draft={bodyHtml}
                onUseDraft={setBodyHtml}
                booking={{
                  bookerPillarId,
                  targetType: "newsletter_post",
                  targetTitle: title.trim() || undefined,
                }}
              />
            )}
            {createOffer.isError && (
              <p className="text-sm text-[#E8352A] mb-3">
                {(createOffer.error as Error).message}
              </p>
            )}
            <button
              disabled={!canSubmit}
              onClick={() => createOffer.mutate()}
              className="bg-[#8C1515] text-white px-5 py-2.5 rounded-lg font-medium hover:bg-[#a01a1a] transition disabled:opacity-50"
              data-testid="button-submit-offer"
            >
              {createOffer.isPending
                ? "Submitting…"
                : "Offer to the newsletter"}
            </button>
          </section>

          {/* My offers */}
          <section className="mb-10">
            <h2 className="font-serif text-xl mb-4">Your offers</h2>
            {offersQuery.isLoading ? (
              <p className="text-[#8a6a5a]">Loading…</p>
            ) : offersQuery.data && offersQuery.data.offers.length > 0 ? (
              <div className="space-y-3">
                {offersQuery.data.offers.map((o) => (
                  <div
                    key={o.id}
                    className="border border-[#E8DDD0] rounded-xl p-4"
                    data-testid={`offer-${o.id}`}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="font-medium text-[#572020]">{o.title}</h3>
                      <span
                        className={`text-[10px] tracking-[0.15em] uppercase px-2 py-1 rounded ${offerStatusStyle[o.status]}`}
                      >
                        {o.status}
                      </span>
                    </div>
                    {o.summary && (
                      <p className="text-sm text-[#8a6a5a] mt-1">{o.summary}</p>
                    )}
                    {o.status === "declined" && o.declineReason && (
                      <p className="text-xs text-[#8C1515] mt-2">
                        Editor note: {o.declineReason}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[#8a6a5a] text-sm">
                No offers yet. Submit one above to get started.
              </p>
            )}
          </section>
        </>
      )}

      {/* ── Matt outlet — communication-angle articles (coming soon) ── */}
      {activeOutlet === "matt" && (
        <>
          <ChannelDetailBack onBack={() => setActiveOutlet(null)} />

          {/* Offer an article to Matt Abrahams (communication angle) */}
          <section className="mb-10">
            <div className="flex items-center gap-3 mb-1">
              <h2 className="font-serif text-xl">Offer an article to Matt</h2>
              {mattComingSoon && (
                <span
                  className="text-[10px] tracking-[0.15em] uppercase px-2 py-1 rounded bg-[#E8DDD0] text-[#8a6a5a]"
                  data-testid="badge-matt-soon"
                >
                  Soon
                </span>
              )}
            </div>
            <p className="text-sm text-[#8a6a5a] mb-4">
              {mattComingSoon
                ? "A separate path for communication-focused articles, reviewed by Matt Abrahams in his own queue. This channel isn't open yet — check back soon."
                : "A separate path for communication-focused articles. Matt Abrahams reviews these in his own queue — they don't go to the SLM newsletter."}
            </p>
            <div className="space-y-3 mb-6">
              <input
                value={mattTitle}
                onChange={(e) => setMattTitle(e.target.value)}
                placeholder="Article title"
                disabled={mattComingSoon}
                className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 bg-white text-[#572020] placeholder:text-[#b39b8c] focus:outline-none focus:ring-2 focus:ring-[#8C1515]/30 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="input-matt-title"
              />
              <textarea
                value={mattSummary}
                onChange={(e) => setMattSummary(e.target.value)}
                placeholder="Short summary (optional)"
                rows={2}
                disabled={mattComingSoon}
                className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 bg-white text-[#572020] placeholder:text-[#b39b8c] focus:outline-none focus:ring-2 focus:ring-[#8C1515]/30 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="input-matt-summary"
              />
              <textarea
                value={mattBody}
                onChange={(e) => setMattBody(e.target.value)}
                placeholder="Article body (optional — you can send a draft now and finish later)"
                rows={6}
                disabled={mattComingSoon}
                className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 bg-white text-[#572020] placeholder:text-[#b39b8c] focus:outline-none focus:ring-2 focus:ring-[#8C1515]/30 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="input-matt-body"
              />
              {!mattComingSoon && bookerPillarId !== undefined && (
                <FrameworkApplyPanel
                  kind="article"
                  draft={mattBody}
                  onUseDraft={setMattBody}
                  booking={{
                    bookerPillarId,
                    targetType: "communication_offer",
                    targetTitle: mattTitle.trim() || undefined,
                  }}
                />
              )}
              {createMattOffer.isError && (
                <p className="text-sm text-[#8C1515]">
                  Couldn't submit — check the title and try again.
                </p>
              )}
              <button
                onClick={() => createMattOffer.mutate()}
                disabled={
                  mattComingSoon ||
                  !mattTitle.trim() ||
                  createMattOffer.isPending
                }
                className="bg-[#8C1515] hover:bg-[#a01a1a] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
                data-testid="button-offer-matt"
              >
                {mattComingSoon
                  ? "Coming soon"
                  : createMattOffer.isPending
                    ? "Submitting…"
                    : "Offer to Matt"}
              </button>
            </div>
            <h3 className="font-serif text-lg mb-3">Your offers to Matt</h3>
            {mattOffersQuery.isLoading ? (
              <p className="text-[#8a6a5a]">Loading…</p>
            ) : mattOffersQuery.data &&
              mattOffersQuery.data.offers.length > 0 ? (
              <div className="space-y-3">
                {mattOffersQuery.data.offers.map((o) => (
                  <div
                    key={o.id}
                    className="border border-[#E8DDD0] rounded-xl p-4"
                    data-testid={`matt-offer-${o.id}`}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="font-medium text-[#572020]">{o.title}</h3>
                      <span
                        className={`text-[10px] tracking-[0.15em] uppercase px-2 py-1 rounded ${offerStatusStyle[o.status]}`}
                      >
                        {o.status}
                      </span>
                    </div>
                    {o.summary && (
                      <p className="text-sm text-[#8a6a5a] mt-1">{o.summary}</p>
                    )}
                    {o.reviewerNote && (
                      <p className="text-xs text-[#8C1515] mt-2">
                        Matt's note: {o.reviewerNote}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[#8a6a5a] text-sm">
                No offers to Matt yet. Submit one above to get started.
              </p>
            )}
          </section>
        </>
      )}

      {/* ── ParentData outlet — pitch articles to ParentData's editor ── */}
      {activeOutlet === "parentdata" && (
        <>
          <ChannelDetailBack onBack={() => setActiveOutlet(null)} />

          {/* Offer an article to ParentData.org */}
          <section className="mb-10">
            <div className="flex items-center gap-3 mb-1">
              <h2 className="font-serif text-xl">
                Offer an article to ParentData
              </h2>
              <span className="text-[10px] tracking-[0.15em] uppercase px-2 py-1 rounded bg-[#DCEFEC] text-[#0a5c5b]">
                Live
              </span>
            </div>
            <p className="text-sm text-[#8a6a5a] mb-4">
              Propose a written piece to ParentData.org — either an open call
              below or an idea of your own. Their editor reviews each proposal
              in her own queue and can message you back here; these don't go to
              the SLM newsletter. If she accepts, she may attach a payment.
            </p>
            {parentDataCalls.length > 0 && (
              <div className="mb-5 rounded-xl border border-[#cfe6e2] bg-[#f0f8f6] p-4">
                <h3 className="font-serif text-base mb-2 text-[#0a5c5b]">
                  Open calls for articles
                </h3>
                <div className="space-y-2">
                  {parentDataCalls.map((c) => {
                    const selected = pdCallId === String(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() =>
                          setPdCallId(selected ? "" : String(c.id))
                        }
                        className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                          selected
                            ? "border-[#0E7C7B] bg-white ring-2 ring-[#0E7C7B]/30"
                            : "border-[#cfe6e2] bg-white/60 hover:bg-white"
                        }`}
                        data-testid={`parentdata-call-${c.id}`}
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="font-medium text-[#572020]">
                            {c.title}
                          </span>
                          {c.budgetCents != null && (
                            <span className="text-xs font-semibold text-[#0a5c5b] whitespace-nowrap">
                              Budget {formatParentDataMoney(c.budgetCents)}
                            </span>
                          )}
                        </div>
                        {c.brief && (
                          <p className="text-sm text-[#8a6a5a] mt-1">
                            {c.brief}
                          </p>
                        )}
                        {selected && (
                          <p className="text-xs text-[#0E7C7B] mt-1 font-medium">
                            ✓ Your proposal will answer this call. Click again
                            to un-link.
                          </p>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="space-y-3 mb-6">
              <input
                value={pdTitle}
                onChange={(e) => setPdTitle(e.target.value)}
                placeholder="Article title"
                className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 bg-white text-[#572020] placeholder:text-[#b39b8c] focus:outline-none focus:ring-2 focus:ring-[#0E7C7B]/30"
                data-testid="input-parentdata-title"
              />
              <textarea
                value={pdSummary}
                onChange={(e) => setPdSummary(e.target.value)}
                placeholder="Short summary (optional)"
                rows={2}
                className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 bg-white text-[#572020] placeholder:text-[#b39b8c] focus:outline-none focus:ring-2 focus:ring-[#0E7C7B]/30"
                data-testid="input-parentdata-summary"
              />
              <textarea
                value={pdBody}
                onChange={(e) => setPdBody(e.target.value)}
                placeholder="Article body (optional — you can send a draft now and finish later)"
                rows={6}
                className="w-full border border-[#E8DDD0] rounded-lg px-3 py-2 bg-white text-[#572020] placeholder:text-[#b39b8c] focus:outline-none focus:ring-2 focus:ring-[#0E7C7B]/30"
                data-testid="input-parentdata-body"
              />
              {createParentDataOffer.isError && (
                <p className="text-sm text-[#8C1515]">
                  Couldn't submit — check the title and try again.
                </p>
              )}
              <button
                onClick={() => createParentDataOffer.mutate()}
                disabled={!pdTitle.trim() || createParentDataOffer.isPending}
                className="bg-[#0E7C7B] hover:bg-[#0a5c5b] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
                data-testid="button-offer-parentdata"
              >
                {createParentDataOffer.isPending
                  ? "Submitting…"
                  : "Offer to ParentData"}
              </button>
            </div>
            <h3 className="font-serif text-lg mb-3">
              Your proposals to ParentData
            </h3>
            {parentDataOffersQuery.isLoading ? (
              <p className="text-[#8a6a5a]">Loading…</p>
            ) : parentDataOffersQuery.data &&
              parentDataOffersQuery.data.offers.length > 0 ? (
              <div className="space-y-3">
                {parentDataOffersQuery.data.offers.map((o) => (
                  <div
                    key={o.id}
                    className="border border-[#E8DDD0] rounded-xl p-4"
                    data-testid={`parentdata-offer-${o.id}`}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="font-medium text-[#572020]">{o.title}</h3>
                      <span
                        className={`text-[10px] tracking-[0.15em] uppercase px-2 py-1 rounded ${offerStatusStyle[o.status]}`}
                      >
                        {parentDataStatusLabel[o.status]}
                      </span>
                    </div>
                    {o.callId != null && parentDataCallById.has(o.callId) && (
                      <p className="text-xs font-medium text-[#0a5c5b] mt-1">
                        In response to:{" "}
                        {parentDataCallById.get(o.callId)!.title}
                      </p>
                    )}
                    {o.summary && (
                      <p className="text-sm text-[#8a6a5a] mt-1">{o.summary}</p>
                    )}
                    {o.status === "accepted" && (
                      <p
                        className={`text-xs mt-2 ${
                          o.paymentCents
                            ? "text-[#0a5c5b] font-semibold"
                            : "text-[#8a6a5a]"
                        }`}
                        data-testid={`parentdata-payment-${o.id}`}
                      >
                        {o.paymentCents == null
                          ? "Payment: the editor hasn't decided yet"
                          : o.paymentCents === 0
                            ? "Payment: none for this piece"
                            : `Payment: ${formatParentDataMoney(o.paymentCents)} (recorded by the editor)`}
                      </p>
                    )}
                    {o.reviewerNote && (
                      <p className="text-xs text-[#0a5c5b] mt-2">
                        Editor's note: {o.reviewerNote}
                      </p>
                    )}
                    <ParentDataOfferThread offerId={o.id} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[#8a6a5a] text-sm">
                No proposals to ParentData yet. Submit one above to get started.
              </p>
            )}
          </section>
        </>
      )}
    </PortalShell>
  );
}

// ── My newsletter (faculty self-publish) ─────────────────────────────────────
// A faculty member's OWN newsletter — its own subscribers, issues, branding and
// public signup link, hosted + sent by the platform. Entirely separate from the SLM
// house contribution loop above: self-publishing mints NO reimbursement credits.

interface LandingSection {
  heading: string;
  body: string;
  imagePath: string | null;
  imagePrompt: string | null;
}

interface LandingContent {
  heroEyebrow: string;
  heroHeadline: string;
  heroSubhead: string;
  aboutLead: string;
  sections: LandingSection[];
  benefits: string[];
}

interface FacultyPublication {
  id: number;
  name: string;
  slug: string;
  tagline: string | null;
  description: string | null;
  bylineName: string | null;
  bylineInstitution: string | null;
  accentColor: string | null;
  fromAddress: string | null;
  topic: string | null;
  landingContent: LandingContent | null;
  heroImagePath: string | null;
  heroImagePrompt: string | null;
}

interface PubSubscriber {
  id: number;
  email: string;
  name: string | null;
  status: string;
  createdAt: string;
}

interface PubIssue {
  id: number;
  title: string;
  status: string;
  recipientCount: number | null;
  sentAt: string | null;
  createdAt: string;
  heroImagePath: string | null;
}

interface PubPost {
  id: number;
  title: string | null;
  bodyHtml: string | null;
  pullQuote: string | null;
  authorName: string | null;
  authorInstitution: string | null;
  position: number;
}

function publicOrigin(): string {
  const fromEnv = (
    import.meta.env.VITE_PUBLIC_WEB_ORIGIN as string | undefined
  )?.replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined") {
    const h = window.location.hostname;
    if (h.startsWith("faculty.")) {
      return `${window.location.protocol}//${h.slice("faculty.".length)}`;
    }
  }
  return "https://palonur.com";
}

// Light client-side normalization so the steward can't type an obviously invalid
// handle. Keeps a trailing dash while typing (the server's slugify trims it on
// save); mirrors the server slug rules otherwise.
function normalizeHandleInput(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

function MyNewsletterIssueEditor({
  issueId,
  onBack,
}: {
  issueId: number;
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const [postTitle, setPostTitle] = useState("");
  const [postBody, setPostBody] = useState("");

  const issueQuery = useQuery<{
    issue: PubIssue & {
      subjectLine: string | null;
      previewText: string | null;
      introHtml: string | null;
    };
    posts: PubPost[];
    activeSubscribers: number;
  }>({
    queryKey: ["faculty-pub-issue", issueId],
    queryFn: () => fetchJson(`/api/faculty/publication/issues/${issueId}`),
  });

  const issue = issueQuery.data?.issue;
  const sent = issue?.status === "sent";

  const [title, setTitle] = useState("");
  const [subjectLine, setSubjectLine] = useState("");
  const [introHtml, setIntroHtml] = useState("");
  const [heroImagePath, setHeroImagePath] = useState<string | null>(null);
  const [heroUploading, setHeroUploading] = useState(false);
  const [heroError, setHeroError] = useState<string | null>(null);
  const heroInputRef = useRef<HTMLInputElement>(null);
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (issue && !seeded) {
      setTitle(issue.title ?? "");
      setSubjectLine(issue.subjectLine ?? "");
      setIntroHtml(issue.introHtml ?? "");
      setHeroImagePath(issue.heroImagePath ?? null);
      setSeeded(true);
    }
  }, [issue, seeded]);

  const saveIssue = useMutation({
    mutationFn: () =>
      fetchJson(`/api/faculty/publication/issues/${issueId}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: title.trim() || undefined,
          subjectLine: subjectLine.trim() || null,
          introHtml: introHtml.trim() || null,
          heroImagePath: heroImagePath,
        }),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["faculty-pub-issue", issueId] }),
  });

  async function pickHeroImage(file: File | undefined): Promise<void> {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setHeroError("Please choose an image file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setHeroError("Image must be under 5 MB.");
      return;
    }
    setHeroError(null);
    setHeroUploading(true);
    try {
      const objectPath = await uploadHeadshotFile(file);
      setHeroImagePath(objectPath);
    } catch (e) {
      setHeroError((e as Error).message);
    } finally {
      setHeroUploading(false);
      if (heroInputRef.current) heroInputRef.current.value = "";
    }
  }

  const addPost = useMutation({
    mutationFn: () =>
      fetchJson(`/api/faculty/publication/issues/${issueId}/posts`, {
        method: "POST",
        body: JSON.stringify({
          title: postTitle.trim() || null,
          bodyHtml: postBody.trim() || null,
        }),
      }),
    onSuccess: () => {
      setPostTitle("");
      setPostBody("");
      qc.invalidateQueries({ queryKey: ["faculty-pub-issue", issueId] });
    },
  });

  const deletePost = useMutation({
    mutationFn: (id: number) =>
      fetchJson(`/api/faculty/publication/posts/${id}`, { method: "DELETE" }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["faculty-pub-issue", issueId] }),
  });

  const sendIssue = useMutation({
    mutationFn: () =>
      fetchJson<{ recipientCount?: number }>(
        `/api/faculty/publication/issues/${issueId}/send`,
        { method: "POST" },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["faculty-pub-issue", issueId] });
      qc.invalidateQueries({ queryKey: ["faculty-pub-issues"] });
    },
  });

  const posts = issueQuery.data?.posts ?? [];

  return (
    <div>
      <button
        onClick={onBack}
        className="text-sm text-[#8a6a5a] hover:text-[#8C1515] mb-6"
        data-testid="button-back-issues"
      >
        ← All issues
      </button>

      {issueQuery.isLoading ? (
        <p className="text-[#8a6a5a]">Loading…</p>
      ) : !issue ? (
        <p className="text-[#8a6a5a]">Issue not found.</p>
      ) : (
        <>
          <div className="flex items-center justify-between mb-6">
            <h2 className="font-serif text-2xl">Edit issue</h2>
            <span
              className={`text-[11px] px-2 py-1 rounded ${
                sent
                  ? "bg-[#2e7d32]/10 text-[#2e7d32]"
                  : "bg-[#8C1515]/10 text-[#8C1515]"
              }`}
            >
              {sent ? "Sent" : "Draft"}
            </span>
          </div>

          <div className="space-y-4 mb-10">
            <label className="block">
              <span className="text-sm text-[#572020]">Title</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={sent}
                className="mt-1 w-full rounded-lg border border-[#E8DDD0] bg-white px-3 py-2"
                data-testid="input-issue-title"
              />
            </label>
            <label className="block">
              <span className="text-sm text-[#572020]">
                Subject line (email)
              </span>
              <input
                value={subjectLine}
                onChange={(e) => setSubjectLine(e.target.value)}
                disabled={sent}
                className="mt-1 w-full rounded-lg border border-[#E8DDD0] bg-white px-3 py-2"
                data-testid="input-issue-subject"
              />
            </label>
            <label className="block">
              <span className="text-sm text-[#572020]">Intro (HTML)</span>
              <textarea
                value={introHtml}
                onChange={(e) => setIntroHtml(e.target.value)}
                disabled={sent}
                rows={3}
                className="mt-1 w-full rounded-lg border border-[#E8DDD0] bg-white px-3 py-2"
                data-testid="input-issue-intro"
              />
            </label>
            <div className="block">
              <span className="text-sm text-[#572020]">Cover image</span>
              <p className="text-xs text-[#8a6a5a] mt-0.5 mb-2">
                Shown as the hero on your public newsletter home, on this
                issue's reading page, and when the issue is shared on social.
              </p>
              {heroImagePath ? (
                <div className="rounded-lg border border-[#E8DDD0] bg-white overflow-hidden">
                  <img
                    src={`/api/storage${heroImagePath}`}
                    alt="Cover preview"
                    className="w-full max-h-56 object-cover"
                    data-testid="img-hero-preview"
                  />
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-[#E8DDD0] bg-[#F9F5EE] px-4 py-6 text-center text-sm text-[#8a6a5a]">
                  No cover image yet.
                </div>
              )}
              <input
                ref={heroInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => pickHeroImage(e.target.files?.[0])}
                data-testid="input-hero-image"
              />
              {!sent && (
                <div className="flex items-center gap-2 flex-wrap mt-2">
                  <button
                    type="button"
                    disabled={heroUploading}
                    onClick={() => heroInputRef.current?.click()}
                    className="rounded-lg bg-[#8C1515] px-3 py-1.5 text-white text-sm hover:bg-[#a01a1a] disabled:opacity-60"
                    data-testid="button-upload-hero"
                  >
                    {heroUploading
                      ? "Uploading…"
                      : heroImagePath
                        ? "Change cover"
                        : "Upload cover"}
                  </button>
                  {heroImagePath && !heroUploading && (
                    <button
                      type="button"
                      onClick={() => setHeroImagePath(null)}
                      className="text-xs text-[#E8352A] hover:underline"
                      data-testid="button-remove-hero"
                    >
                      Remove
                    </button>
                  )}
                </div>
              )}
              {heroError && (
                <p
                  className="text-xs text-[#E8352A] mt-1"
                  data-testid="text-hero-error"
                >
                  {heroError}
                </p>
              )}
            </div>
            {!sent && (
              <button
                onClick={() => saveIssue.mutate()}
                disabled={saveIssue.isPending || heroUploading}
                className="rounded-lg bg-[#8C1515] px-4 py-2 text-white text-sm hover:bg-[#a01a1a] disabled:opacity-60"
                data-testid="button-save-issue"
              >
                {saveIssue.isPending ? "Saving…" : "Save"}
              </button>
            )}
          </div>

          <h3 className="font-serif text-xl mb-3">Posts</h3>
          <div className="space-y-3 mb-6">
            {posts.length === 0 && (
              <p className="text-sm text-[#8a6a5a]">No posts yet.</p>
            )}
            {posts.map((p) => (
              <div
                key={p.id}
                className="rounded-lg border border-[#E8DDD0] bg-white p-4"
                data-testid={`post-${p.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-[#572020]">
                      {p.title || "Untitled"}
                    </p>
                    {p.bodyHtml && (
                      <p className="text-sm text-[#8a6a5a] mt-1 line-clamp-2">
                        {p.bodyHtml.replace(/<[^>]+>/g, "").slice(0, 160)}
                      </p>
                    )}
                  </div>
                  {!sent && (
                    <button
                      onClick={() => deletePost.mutate(p.id)}
                      className="text-xs text-[#E8352A] hover:underline flex-none"
                      data-testid={`button-delete-post-${p.id}`}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {!sent && (
            <div className="rounded-lg border border-[#E8DDD0] bg-[#F9F5EE] p-4 mb-10 space-y-3">
              <input
                value={postTitle}
                onChange={(e) => setPostTitle(e.target.value)}
                placeholder="Post title"
                className="w-full rounded-lg border border-[#E8DDD0] bg-white px-3 py-2"
                data-testid="input-post-title"
              />
              <textarea
                value={postBody}
                onChange={(e) => setPostBody(e.target.value)}
                placeholder="Body (HTML allowed)"
                rows={4}
                className="w-full rounded-lg border border-[#E8DDD0] bg-white px-3 py-2"
                data-testid="input-post-body"
              />
              <button
                onClick={() => addPost.mutate()}
                disabled={addPost.isPending || !postTitle.trim()}
                className="rounded-lg bg-[#8C1515] px-4 py-2 text-white text-sm hover:bg-[#a01a1a] disabled:opacity-60"
                data-testid="button-add-post"
              >
                {addPost.isPending ? "Adding…" : "Add post"}
              </button>
            </div>
          )}

          <div className="border-t border-[#E8DDD0] pt-6">
            {sent ? (
              <p className="text-sm text-[#2e7d32]">
                Sent to {issue.recipientCount ?? 0} subscribers.
              </p>
            ) : (
              <>
                <p className="text-sm text-[#8a6a5a] mb-3">
                  {issueQuery.data?.activeSubscribers ?? 0} active subscribers
                  will receive this issue. Sending is final.
                </p>
                <button
                  onClick={() => sendIssue.mutate()}
                  disabled={sendIssue.isPending || posts.length === 0}
                  className="rounded-lg bg-[#8C1515] px-5 py-2.5 text-white text-sm hover:bg-[#a01a1a] disabled:opacity-60"
                  data-testid="button-send-issue"
                >
                  {sendIssue.isPending ? "Sending…" : "Send issue"}
                </button>
                {sendIssue.isError && (
                  <p className="text-sm text-[#E8352A] mt-2">
                    {(sendIssue.error as Error).message}
                  </p>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- Voice profile ----------
// The steward-facing loop for the embeddable expert agent's voice. The voice
// only restyles grounded, cited answers — it never invents facts.

type VoiceFields = {
  toneSummary: string;
  guidance: string;
  signaturePhrases: string[];
  avoidPhrases: string[];
};

interface VoiceProfileResponse {
  profile:
    | (VoiceFields & {
        source: "manual" | "ai_distilled" | "manual_edit";
        approvedAt: string | null;
      })
    | null;
  exemplarCount: number;
  talkSampleCount: number;
  aiAvailable: boolean;
}

type VoiceDistillResponse =
  | {
      ok: true;
      draft: VoiceFields;
      provenance: Record<string, unknown>;
      exemplarCount: number;
      talkSampleCount: number;
    }
  | {
      ok: false;
      reason: "no_material" | "ai_unavailable" | "ai_error" | "unparseable";
      exemplarCount: number;
      talkSampleCount: number;
    };

interface VoicePreviewResponse {
  answer: string;
  uncovered?: boolean;
  refused?: boolean;
  provenance: unknown[];
  citationVerification: {
    status: "verified" | "unmatched" | "missing";
    [k: string]: unknown;
  } | null;
  voiceVerification: {
    status?: "ok" | "flagged" | "skipped";
    ok?: boolean;
    firstPersonOk?: boolean;
    bannedHits?: string[];
    genericHits?: string[];
    flags?: string[];
    reason?: string;
  } | null;
}

const VOICE_DISTILL_MESSAGES: Record<string, string> = {
  no_material:
    "There's nothing to learn from yet. Approve a few interpretations or add an approved talk transcript, then try again.",
  ai_unavailable:
    "AI isn't configured in this environment, so a draft can't be generated automatically. You can still write your voice by hand.",
  ai_error:
    "The AI couldn't be reached just now. Please try again in a moment.",
  unparseable:
    "The AI returned something we couldn't read as a draft. Please try again.",
};

/**
 * A simple string[] editor: one input + Add button, with removable chips. Used
 * for both the signature-phrase and avoid-phrase lists on the voice page.
 */
function VoicePhraseEditor({
  label,
  hint,
  testidRoot,
  phrases,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  testidRoot: string;
  phrases: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (!phrases.includes(v)) onChange([...phrases, v]);
    setDraft("");
  };
  return (
    <div data-testid={testidRoot}>
      <label className="text-xs uppercase tracking-[0.2em] text-[#8a6a5a] mb-1 block">
        {label}
      </label>
      {hint && <p className="text-xs text-[#8a6a5a] mb-2">{hint}</p>}
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add a phrase…"
          className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm text-[#572020] w-full disabled:opacity-50"
          data-testid={`${testidRoot}-input`}
        />
        <button
          type="button"
          onClick={add}
          disabled={disabled || !draft.trim()}
          className="flex-none bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition disabled:opacity-40"
          data-testid={`${testidRoot}-add`}
        >
          Add
        </button>
      </div>
      {phrases.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2">
          {phrases.map((p, i) => (
            <span
              key={`${p}-${i}`}
              className="inline-flex items-center gap-1.5 bg-white border border-[#E8DDD0] rounded-full pl-3 pr-1.5 py-1 text-sm text-[#572020]"
              data-testid={`${testidRoot}-chip-${i}`}
            >
              {p}
              <button
                type="button"
                onClick={() => onChange(phrases.filter((_, j) => j !== i))}
                disabled={disabled}
                aria-label={`Remove ${p}`}
                className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[#8a6a5a] hover:bg-[#8C1515]/10 hover:text-[#8C1515] transition disabled:opacity-40"
                data-testid={`${testidRoot}-remove-${i}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function VoiceProfilePage() {
  const { data: me, isLoading: meLoading } = useMe();
  const qc = useQueryClient();

  const profileQuery = useQuery<VoiceProfileResponse>({
    queryKey: ["faculty-voice-profile"],
    queryFn: () => fetchJson("/api/faculty/voice-profile"),
    enabled: !!me && !me.awaitingInvitation,
  });

  const [toneSummary, setToneSummary] = useState("");
  const [guidance, setGuidance] = useState("");
  const [signaturePhrases, setSignaturePhrases] = useState<string[]>([]);
  const [avoidPhrases, setAvoidPhrases] = useState<string[]>([]);
  const [seeded, setSeeded] = useState(false);

  // Bookkeeping so Save picks the right `source`: a from-scratch save is
  // "manual"; a draft saved verbatim is "ai_distilled"; an edited draft is
  // "manual_edit". `draftBaseline` is the JSON of the draft as the editor
  // received it, and `distilledFrom` is the distiller's provenance to pass back.
  const [draftBaseline, setDraftBaseline] = useState<string | null>(null);
  const [distilledFrom, setDistilledFrom] = useState<Record<
    string,
    unknown
  > | null>(null);

  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [distillMsg, setDistillMsg] = useState<string | null>(null);

  useEffect(() => {
    const p = profileQuery.data?.profile;
    if (p && !seeded) {
      setToneSummary(p.toneSummary ?? "");
      setGuidance(p.guidance ?? "");
      setSignaturePhrases(p.signaturePhrases ?? []);
      setAvoidPhrases(p.avoidPhrases ?? []);
      setSeeded(true);
    }
  }, [profileQuery.data, seeded]);

  const currentFields = (): VoiceFields => ({
    toneSummary: toneSummary.trim(),
    guidance: guidance.trim(),
    signaturePhrases,
    avoidPhrases,
  });

  const resolveSource = (): "manual" | "ai_distilled" | "manual_edit" => {
    if (!draftBaseline) return "manual";
    return JSON.stringify(currentFields()) === draftBaseline
      ? "ai_distilled"
      : "manual_edit";
  };

  const distill = useMutation<VoiceDistillResponse>({
    mutationFn: () =>
      fetchJson<VoiceDistillResponse>("/api/faculty/voice-profile/distill", {
        method: "POST",
      }),
    onMutate: () => {
      setDistillMsg(null);
      setSaveMsg(null);
    },
    onSuccess: (d) => {
      if (d.ok) {
        const draft: VoiceFields = {
          toneSummary: (d.draft.toneSummary ?? "").trim(),
          guidance: (d.draft.guidance ?? "").trim(),
          signaturePhrases: d.draft.signaturePhrases ?? [],
          avoidPhrases: d.draft.avoidPhrases ?? [],
        };
        setToneSummary(draft.toneSummary);
        setGuidance(draft.guidance);
        setSignaturePhrases(draft.signaturePhrases);
        setAvoidPhrases(draft.avoidPhrases);
        setDraftBaseline(JSON.stringify(draft));
        setDistilledFrom(d.provenance ?? null);
        setSeeded(true);
        setDistillMsg(
          "Draft ready. Review and edit it below, then Save to approve.",
        );
      } else {
        setDistillMsg(
          VOICE_DISTILL_MESSAGES[d.reason] ?? "Could not generate a draft.",
        );
      }
    },
    onError: (e) => setDistillMsg((e as Error).message),
  });

  const save = useMutation<{ profile: unknown }>({
    mutationFn: () =>
      fetchJson<{ profile: unknown }>("/api/faculty/voice-profile", {
        method: "PUT",
        body: JSON.stringify({
          ...currentFields(),
          source: resolveSource(),
          ...(draftBaseline ? { distilledFrom } : {}),
        }),
      }),
    onMutate: () => setSaveMsg(null),
    onSuccess: () => {
      setSaveMsg("Saved. Your voice is approved and live.");
      qc.invalidateQueries({ queryKey: ["faculty-voice-profile"] });
    },
    onError: (e) => setSaveMsg((e as Error).message),
  });

  const stewardPillars = useMemo(() => {
    if (!me) return [];
    const stewardIds = new Set(
      me.memberships.filter((m) => m.role === "steward").map((m) => m.pillarId),
    );
    const filtered = me.pillars.filter((p) => stewardIds.has(p.id));
    if (filtered.length === 0 && me.user.isPlatformAdmin) return me.pillars;
    return filtered;
  }, [me]);

  const [previewPillarId, setPreviewPillarId] = useState<number | "">("");
  const [question, setQuestion] = useState("");

  useEffect(() => {
    if (previewPillarId === "" && stewardPillars.length > 0) {
      setPreviewPillarId(stewardPillars[0]!.id);
    }
  }, [stewardPillars, previewPillarId]);

  const preview = useMutation<VoicePreviewResponse>({
    mutationFn: async () => {
      if (previewPillarId === "") throw new Error("Pick a pillar to preview.");
      if (!question.trim()) throw new Error("Type a question to preview.");
      return fetchJson<VoicePreviewResponse>(
        "/api/faculty/voice-profile/preview",
        {
          method: "POST",
          body: JSON.stringify({
            pillarId: previewPillarId,
            message: question.trim(),
            profile: currentFields(),
          }),
        },
      );
    },
  });

  if (meLoading)
    return (
      <PortalShell>
        <p className="text-[#8a6a5a]" data-testid="text-voice-loading">
          Loading…
        </p>
      </PortalShell>
    );
  if (me && me.awaitingInvitation) return <Redirect to="/awaiting-invite" />;

  const labelCls =
    "text-xs uppercase tracking-[0.2em] text-[#8a6a5a] mb-1 block";
  const data = profileQuery.data;
  const previewData = preview.data;
  const cv = previewData?.citationVerification ?? null;
  const vv = previewData?.voiceVerification ?? null;
  const vvOk = vv ? (vv.ok ?? vv.status === "ok") : null;
  const vvFlags = vv
    ? (vv.flags ?? [...(vv.bannedHits ?? []), ...(vv.genericHits ?? [])])
    : [];

  return (
    <PortalShell>
      <header className="mb-10">
        <p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-3">
          Embeddable expert agent
        </p>
        <h1 className="font-serif text-3xl md:text-4xl font-medium mb-3">
          Your voice
        </h1>
        <p className="text-[#8a6a5a] leading-relaxed max-w-2xl">
          This shapes how your embeddable expert agent sounds when it answers in
          your name. Voice only restyles grounded, cited answers. It never
          invents facts or relaxes the citation discipline.
        </p>
        <p className="text-[#8a6a5a] leading-relaxed max-w-2xl mt-3">
          Our system already works behind the scenes to keep every answer in your
          expert voice. This is the place where you can review it and make your
          own adjustments, so it sounds unmistakably like you.
        </p>
      </header>

      {profileQuery.isLoading ? (
        <p className="text-[#8a6a5a]" data-testid="text-voice-profile-loading">
          Loading your voice profile…
        </p>
      ) : profileQuery.isError ? (
        <div
          className="rounded-lg border border-[#E8DDD0] bg-[#FBEAE9] p-4 text-[#E8352A]"
          data-testid="text-voice-profile-error"
        >
          Couldn't load your voice profile.{" "}
          {(profileQuery.error as Error)?.message}
        </div>
      ) : (
        <div className="grid gap-8 md:grid-cols-[1.3fr_1fr] md:items-start">
          {/* Editor */}
          <section className="rounded-lg border border-[#E8DDD0] bg-gradient-to-br from-[#F9F5EE] to-[#F4ECDD] p-6">
            <div className="flex items-start justify-between gap-4 mb-5">
              <div>
                <h2 className="font-serif text-xl font-medium">
                  Voice profile
                </h2>
                <p
                  className="text-xs text-[#8a6a5a] mt-1"
                  data-testid="text-voice-corpus"
                >
                  {data?.exemplarCount ?? 0} approved interpretations ·{" "}
                  {data?.talkSampleCount ?? 0} talk samples
                </p>
                {data?.profile?.approvedAt && (
                  <p className="text-xs text-[#8a6a5a] mt-0.5">
                    Last approved{" "}
                    {new Date(data.profile.approvedAt).toLocaleDateString()}
                  </p>
                )}
              </div>
              <span
                className="flex-none text-[10px] uppercase tracking-[0.2em] text-[#8a6a5a]"
                data-testid="text-voice-source"
              >
                {data?.profile
                  ? data.profile.source === "ai_distilled"
                    ? "AI distilled"
                    : data.profile.source === "manual_edit"
                      ? "Edited draft"
                      : "Hand-written"
                  : "Not set yet"}
              </span>
            </div>

            <div className="mb-4">
              <button
                type="button"
                onClick={() => distill.mutate()}
                disabled={distill.isPending || !data?.aiAvailable}
                title={
                  data?.aiAvailable
                    ? "Draft a voice profile from your own approved interpretations and talks"
                    : "AI is not configured in this environment"
                }
                className="bg-white border border-[#8C1515] text-[#8C1515] px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#8C1515]/5 transition disabled:opacity-40"
                data-testid="button-distill"
              >
                {distill.isPending
                  ? "Generating…"
                  : "Generate from my material"}
              </button>
              {!data?.aiAvailable && (
                <p className="text-xs text-[#8a6a5a] mt-2">
                  AI isn't configured here, so you can still write your voice by
                  hand below.
                </p>
              )}
              {distillMsg && (
                <p
                  className="text-sm text-[#572020] mt-2"
                  data-testid="text-distill-message"
                >
                  {distillMsg}
                </p>
              )}
            </div>

            <div className="space-y-5">
              <div>
                <label htmlFor="voice-tone" className={labelCls}>
                  Tone summary
                </label>
                <textarea
                  id="voice-tone"
                  value={toneSummary}
                  onChange={(e) => setToneSummary(e.target.value)}
                  rows={3}
                  placeholder="How you sound in one or two sentences: warm, direct, plain-spoken…"
                  className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm text-[#572020] w-full"
                  data-testid="input-tone-summary"
                />
              </div>

              <div>
                <label htmlFor="voice-guidance" className={labelCls}>
                  Guidance / do's and don'ts
                </label>
                <textarea
                  id="voice-guidance"
                  value={guidance}
                  onChange={(e) => setGuidance(e.target.value)}
                  rows={5}
                  placeholder="First-person notes on how to speak as you: what to lean into, what to avoid…"
                  className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm text-[#572020] w-full"
                  data-testid="input-guidance"
                />
              </div>

              <VoicePhraseEditor
                label="Signature phrases"
                hint="Phrases you naturally use."
                testidRoot="editor-signature-phrases"
                phrases={signaturePhrases}
                onChange={setSignaturePhrases}
              />

              <VoicePhraseEditor
                label="Avoid phrases"
                hint="Phrasings that don't sound like you."
                testidRoot="editor-avoid-phrases"
                phrases={avoidPhrases}
                onChange={setAvoidPhrases}
              />
            </div>

            <div className="mt-6 flex items-center gap-3 border-t border-[#E8DDD0] pt-5">
              <button
                type="button"
                onClick={() => save.mutate()}
                disabled={save.isPending}
                className="bg-[#8C1515] text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition disabled:opacity-40"
                data-testid="button-save-voice"
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
              {saveMsg && (
                <p
                  className="text-sm text-[#572020]"
                  data-testid="text-save-message"
                >
                  {saveMsg}
                </p>
              )}
            </div>
          </section>

          {/* Preview */}
          <section className="rounded-lg border border-[#E8DDD0] bg-white p-6">
            <h2 className="font-serif text-xl font-medium mb-1">
              Hear your voice
            </h2>
            <p className="text-sm text-[#8a6a5a] mb-5">
              Ask a question and preview the agent answering in your voice using
              your current (unsaved) edits.
            </p>

            <div className="space-y-4">
              <div>
                <label htmlFor="preview-pillar" className={labelCls}>
                  Pillar
                </label>
                <select
                  id="preview-pillar"
                  value={previewPillarId === "" ? "" : String(previewPillarId)}
                  onChange={(e) =>
                    setPreviewPillarId(
                      e.target.value === "" ? "" : Number(e.target.value),
                    )
                  }
                  disabled={stewardPillars.length === 0}
                  className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm text-[#572020] w-full"
                  data-testid="select-preview-pillar"
                >
                  {stewardPillars.length === 0 ? (
                    <option value="">No stewarded pillars</option>
                  ) : (
                    stewardPillars.map((p) => (
                      <option key={p.id} value={String(p.id)}>
                        {p.name}
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div>
                <label htmlFor="preview-question" className={labelCls}>
                  Question
                </label>
                <textarea
                  id="preview-question"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  rows={3}
                  placeholder="Ask something a visitor might ask…"
                  className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm text-[#572020] w-full"
                  data-testid="input-preview-question"
                />
              </div>

              <button
                type="button"
                onClick={() => preview.mutate()}
                disabled={
                  preview.isPending ||
                  stewardPillars.length === 0 ||
                  !question.trim()
                }
                className="bg-[#8C1515] text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition disabled:opacity-40"
                data-testid="button-preview"
              >
                {preview.isPending ? "Thinking…" : "Preview"}
              </button>
            </div>

            {preview.isError && (
              <div
                className="mt-5 rounded-lg border border-[#E8DDD0] bg-[#FBEAE9] p-4 text-sm text-[#E8352A]"
                data-testid="text-preview-error"
              >
                {(preview.error as Error)?.message ??
                  "Preview failed. AI may not be configured."}
              </div>
            )}

            {previewData && (
              <div className="mt-5">
                {(cv || vv) && (
                  <div className="flex flex-wrap gap-2 mb-3">
                    {cv && (
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
                          cv.status === "verified"
                            ? "bg-[#E8F3EC] text-[#1E6B3A]"
                            : "bg-[#FBEAE9] text-[#E8352A]"
                        }`}
                        data-testid="badge-citation-verification"
                      >
                        {cv.status === "verified"
                          ? "Citation verified"
                          : cv.status === "unmatched"
                            ? "Citation unmatched"
                            : "No citation"}
                      </span>
                    )}
                    {vv && vvOk !== null && (
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
                          vvOk
                            ? "bg-[#E8F3EC] text-[#1E6B3A]"
                            : "bg-[#FBEAE9] text-[#E8352A]"
                        }`}
                        data-testid="badge-voice-verification"
                      >
                        {vvOk
                          ? "Voice ✓"
                          : `Voice flagged${
                              vvFlags.length ? `: ${vvFlags.join(", ")}` : ""
                            }`}
                      </span>
                    )}
                  </div>
                )}

                {previewData.uncovered && (
                  <p
                    className="mb-3 text-sm text-[#8a6a5a]"
                    data-testid="text-preview-uncovered"
                  >
                    Uncovered. There's no approved material on this yet, so the
                    agent declines rather than guessing.
                  </p>
                )}
                {previewData.refused && (
                  <p
                    className="mb-3 text-sm text-[#8a6a5a]"
                    data-testid="text-preview-refused"
                  >
                    Refused. This question is outside the pillar's scope.
                  </p>
                )}

                <div
                  className="rounded-lg border border-[#E8DDD0] bg-[#FBF7F0] p-4 text-sm text-[#572020] whitespace-pre-wrap"
                  data-testid="text-preview-answer"
                >
                  {previewData.answer}
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </PortalShell>
  );
}

// A single editable text/textarea field for the landing-page editor.
function LandingFieldRow({
  label,
  value,
  onChange,
  textarea,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  textarea?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-sm text-[#572020]">{label}</span>
      {textarea ? (
        <textarea
          value={value}
          rows={3}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded-lg border border-[#E8DDD0] bg-white px-3 py-2 text-sm"
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded-lg border border-[#E8DDD0] bg-white px-3 py-2 text-sm"
        />
      )}
    </label>
  );
}

// Preview + prompt-driven (re)generation of one landing image. Image generation
// is server-side; this only shows the current image and asks for a new one.
function LandingImageRow({
  label,
  imagePath,
  promptValue,
  busy,
  onRegen,
}: {
  label: string;
  imagePath: string | null;
  promptValue: string;
  busy: boolean;
  onRegen: (prompt: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const effectivePrompt = (prompt.trim() || promptValue || "").trim();
  return (
    <div className="space-y-2">
      <span className="text-sm text-[#572020]">{label}</span>
      {imagePath ? (
        <img
          src={`/api/storage${imagePath}`}
          alt=""
          className="w-full max-w-md rounded-lg border border-[#E8DDD0] object-cover"
          style={{ aspectRatio: "16 / 9" }}
        />
      ) : (
        <p className="text-xs text-[#a08070]">No image yet.</p>
      )}
      <div className="flex flex-wrap items-stretch gap-2">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the image (optional — uses the heading otherwise)"
          className="flex-1 min-w-[240px] rounded-lg border border-[#E8DDD0] bg-white px-3 py-2 text-sm"
        />
        <button
          onClick={() => onRegen(effectivePrompt)}
          disabled={busy || effectivePrompt.length < 2}
          className="rounded-lg border border-[#8C1515] px-3 py-2 text-sm text-[#8C1515] hover:bg-[#8C1515] hover:text-white disabled:opacity-60"
        >
          {imagePath ? "Replace image" : "Generate image"}
        </button>
      </div>
    </div>
  );
}

function MyNewsletter() {
  const { data: me, isLoading: meLoading } = useMe();
  const qc = useQueryClient();
  const [openIssue, setOpenIssue] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedIssueId, setCopiedIssueId] = useState<number | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newIssueTitle, setNewIssueTitle] = useState("");

  const pubQuery = useQuery<{ publication: FacultyPublication }>({
    queryKey: ["faculty-publication"],
    queryFn: () => fetchJson("/api/faculty/publication"),
    enabled: !!me && !me.awaitingInvitation,
  });

  const subsQuery = useQuery<{
    subscribers: PubSubscriber[];
    counts: { total: number; active: number; unsubscribed: number };
  }>({
    queryKey: ["faculty-pub-subscribers"],
    queryFn: () => fetchJson("/api/faculty/publication/subscribers"),
    enabled: !!me && !me.awaitingInvitation,
  });

  const issuesQuery = useQuery<{ issues: PubIssue[] }>({
    queryKey: ["faculty-pub-issues"],
    queryFn: () => fetchJson("/api/faculty/publication/issues"),
    enabled: !!me && !me.awaitingInvitation,
  });

  const pub = pubQuery.data?.publication;

  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const [description, setDescription] = useState("");
  const [accentColor, setAccentColor] = useState("");
  const [settingsSeeded, setSettingsSeeded] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);
  useEffect(() => {
    if (pub && !settingsSeeded) {
      setName(pub.name ?? "");
      setTagline(pub.tagline ?? "");
      setDescription(pub.description ?? "");
      setAccentColor(pub.accentColor ?? "");
      setSettingsSeeded(true);
    }
  }, [pub, settingsSeeded]);

  const saveSettings = useMutation({
    mutationFn: () =>
      fetchJson("/api/faculty/publication", {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim() || undefined,
          tagline: tagline.trim() || null,
          description: description.trim() || null,
          accentColor: accentColor.trim() || null,
        }),
      }),
    onSuccess: () => {
      setSettingsMsg("Saved.");
      qc.invalidateQueries({ queryKey: ["faculty-publication"] });
    },
    onError: (e) => setSettingsMsg((e as Error).message),
  });

  // ── Welcome email (preview + test send to self) ──────────────────────────
  // The one-time branded email a new subscriber gets the moment they confirm.
  // Lets the steward see exactly what readers receive before they do.
  const [welcomeHtml, setWelcomeHtml] = useState<string | null>(null);
  const [welcomeMsg, setWelcomeMsg] = useState<string | null>(null);
  const loadWelcome = useMutation({
    mutationFn: () =>
      fetchJson<{ subject: string; html: string; fromAddress: string }>(
        "/api/faculty/publication/welcome-preview",
      ),
    onMutate: () => setWelcomeMsg(null),
    onSuccess: (d) => setWelcomeHtml(d.html),
    onError: (e) => setWelcomeMsg((e as Error).message),
  });
  const sendWelcomeTest = useMutation({
    mutationFn: () =>
      fetchJson<{ ok: true; to: string }>(
        "/api/faculty/publication/welcome-test",
        { method: "POST" },
      ),
    onMutate: () => setWelcomeMsg(null),
    onSuccess: (d) => setWelcomeMsg(`Test sent to ${d.to}.`),
    onError: (e) => setWelcomeMsg((e as Error).message),
  });

  // ── Landing page (Topic → auto-generated, then editable, editorial page) ──
  const [topic, setTopic] = useState("");
  const [landing, setLanding] = useState<LandingContent | null>(null);
  const [heroImagePath, setHeroImagePath] = useState<string | null>(null);
  const [landingSeeded, setLandingSeeded] = useState(false);
  const [landingMsg, setLandingMsg] = useState<string | null>(null);

  const seedLandingFromPub = (p: FacultyPublication) => {
    setTopic(p.topic ?? "");
    setLanding(p.landingContent ?? null);
    setHeroImagePath(p.heroImagePath ?? null);
  };
  useEffect(() => {
    if (pub && !landingSeeded) {
      seedLandingFromPub(pub);
      setLandingSeeded(true);
    }
  }, [pub, landingSeeded]);

  const generateLanding = useMutation({
    mutationFn: () =>
      fetchJson<{ publication: FacultyPublication }>(
        "/api/faculty/publication/landing/generate",
        { method: "POST", body: JSON.stringify({ topic: topic.trim() }) },
      ),
    onMutate: () => setLandingMsg("Generating… this can take a minute."),
    onSuccess: (d) => {
      seedLandingFromPub(d.publication);
      setLandingMsg("Generated. Edit anything below, then Save.");
      qc.invalidateQueries({ queryKey: ["faculty-publication"] });
    },
    onError: (e) => setLandingMsg((e as Error).message),
  });

  const saveLanding = useMutation({
    mutationFn: () =>
      fetchJson<{ publication: FacultyPublication }>(
        "/api/faculty/publication/landing",
        {
          method: "PUT",
          body: JSON.stringify({
            topic: topic.trim() || null,
            landingContent: landing,
          }),
        },
      ),
    onSuccess: (d) => {
      seedLandingFromPub(d.publication);
      setLandingMsg("Saved.");
      qc.invalidateQueries({ queryKey: ["faculty-publication"] });
    },
    onError: (e) => setLandingMsg((e as Error).message),
  });

  const regenImage = useMutation({
    mutationFn: (vars: { target: "hero" | number; prompt: string }) =>
      fetchJson<{ publication: FacultyPublication }>(
        "/api/faculty/publication/landing/image",
        { method: "POST", body: JSON.stringify(vars) },
      ),
    onMutate: () => setLandingMsg("Generating image…"),
    onSuccess: (d) => {
      seedLandingFromPub(d.publication);
      setLandingMsg("Image updated.");
      qc.invalidateQueries({ queryKey: ["faculty-publication"] });
    },
    onError: (e) => setLandingMsg((e as Error).message),
  });

  const [handle, setHandle] = useState("");
  const [handleSeeded, setHandleSeeded] = useState(false);
  const [handleMsg, setHandleMsg] = useState<string | null>(null);
  useEffect(() => {
    if (pub && !handleSeeded) {
      setHandle(pub.slug);
      setHandleSeeded(true);
    }
  }, [pub, handleSeeded]);

  const saveHandle = useMutation({
    mutationFn: () =>
      fetchJson<{ publication: FacultyPublication }>(
        "/api/faculty/publication/slug",
        {
          method: "PATCH",
          body: JSON.stringify({ slug: handle.trim() }),
        },
      ),
    onSuccess: (d) => {
      setHandleMsg("Saved.");
      setHandle(d.publication.slug);
      qc.invalidateQueries({ queryKey: ["faculty-publication"] });
    },
    onError: (e) => setHandleMsg((e as Error).message),
  });

  const addSub = useMutation({
    mutationFn: () =>
      fetchJson("/api/faculty/publication/subscribers", {
        method: "POST",
        body: JSON.stringify({
          email: newEmail.trim(),
          name: newName.trim() || undefined,
        }),
      }),
    onSuccess: () => {
      setNewEmail("");
      setNewName("");
      qc.invalidateQueries({ queryKey: ["faculty-pub-subscribers"] });
    },
  });

  const deleteSub = useMutation({
    mutationFn: (id: number) =>
      fetchJson(`/api/faculty/publication/subscribers/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["faculty-pub-subscribers"] }),
  });

  const createIssue = useMutation({
    mutationFn: () =>
      fetchJson<{ issue: PubIssue }>("/api/faculty/publication/issues", {
        method: "POST",
        body: JSON.stringify({ title: newIssueTitle.trim() || undefined }),
      }),
    onSuccess: (d) => {
      setNewIssueTitle("");
      qc.invalidateQueries({ queryKey: ["faculty-pub-issues"] });
      if (d.issue?.id) setOpenIssue(d.issue.id);
    },
  });

  const deleteIssue = useMutation({
    mutationFn: (id: number) =>
      fetchJson(`/api/faculty/publication/issues/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["faculty-pub-issues"] }),
  });

  if (meLoading)
    return (
      <PortalShell>
        <p className="text-[#8a6a5a]">Loading…</p>
      </PortalShell>
    );
  if (me && me.awaitingInvitation) return <Redirect to="/awaiting-invite" />;

  const publicUrl = pub ? `${publicOrigin()}/p/${pub.slug}` : "";

  return (
    <PortalShell>
      {openIssue != null ? (
        <MyNewsletterIssueEditor
          issueId={openIssue}
          onBack={() => setOpenIssue(null)}
        />
      ) : (
        <>
          <header className="mb-10">
            <p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-3">
              My newsletter
            </p>
            <h1 className="font-serif text-3xl md:text-4xl font-medium mb-3">
              Your own newsletter
            </h1>
            <p className="text-[#7a5a4a] max-w-2xl leading-relaxed">
              Your own subscribers, issues and branding — hosted and sent by
              Palonur. This is separate from the Stanford Lifestyle Medicine
              house newsletter.
            </p>
          </header>

          {pubQuery.isLoading ? (
            <p className="text-[#8a6a5a]">Loading…</p>
          ) : !pub ? (
            <p className="text-[#8a6a5a]">Couldn't load your publication.</p>
          ) : (
            <div className="space-y-12">
              {/* Public link */}
              <section className="rounded-xl border border-[#E8DDD0] bg-[#F9F5EE] p-5">
                <p className="text-sm text-[#572020] font-medium mb-2">
                  Your public signup page
                </p>
                <p className="text-sm text-[#7a5a4a] leading-relaxed mb-4 max-w-2xl">
                  This is where readers sign up for your newsletter. A custom
                  handle makes the link short, memorable and easy to say out
                  loud — so it's worth sharing.
                </p>
                <div className="flex flex-wrap items-center gap-3 mb-5">
                  <a
                    href={publicUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#8C1515] underline break-all"
                    data-testid="link-public-signup"
                  >
                    {publicUrl}
                  </a>
                  <button
                    onClick={() => {
                      void navigator.clipboard?.writeText(publicUrl);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                    className="text-xs rounded border border-[#E8DDD0] bg-white px-3 py-1.5 hover:border-[#8C1515]"
                    data-testid="button-copy-link"
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>

                {/* Editable handle */}
                <div className="max-w-xl">
                  <label
                    htmlFor="pub-handle-input"
                    className="block text-sm text-[#572020] mb-1.5"
                  >
                    Custom handle
                  </label>
                  <div className="flex flex-wrap items-stretch gap-2">
                    <div className="flex items-stretch rounded-lg border border-[#E8DDD0] bg-white overflow-hidden flex-1 min-w-[260px]">
                      <span className="flex items-center px-3 text-sm text-[#8a6a5a] bg-[#F4ECDD] border-r border-[#E8DDD0] whitespace-nowrap">
                        {`${publicOrigin().replace(/^https?:\/\//, "")}/p/`}
                      </span>
                      <input
                        id="pub-handle-input"
                        value={handle}
                        onChange={(e) => {
                          setHandle(normalizeHandleInput(e.target.value));
                          setHandleMsg(null);
                        }}
                        placeholder="your-name"
                        className="flex-1 min-w-0 px-3 py-2 text-sm outline-none"
                        data-testid="input-pub-handle"
                      />
                    </div>
                    <button
                      onClick={() => saveHandle.mutate()}
                      disabled={
                        saveHandle.isPending ||
                        !handle.trim() ||
                        handle.trim() === pub.slug
                      }
                      className="rounded-lg bg-[#8C1515] px-4 py-2 text-white text-sm hover:bg-[#a01a1a] disabled:opacity-60"
                      data-testid="button-save-handle"
                    >
                      {saveHandle.isPending ? "Saving…" : "Save handle"}
                    </button>
                  </div>
                  {handleMsg && (
                    <p
                      className={`text-sm mt-2 ${
                        handleMsg === "Saved."
                          ? "text-[#2e7d32]"
                          : "text-[#E8352A]"
                      }`}
                      data-testid="text-handle-msg"
                    >
                      {handleMsg}
                    </p>
                  )}
                  <p className="text-xs text-[#a08070] mt-2 leading-relaxed">
                    Changing your handle breaks any link you've already shared —
                    the old address stops working and there's no redirect.
                  </p>
                </div>
              </section>

              {/* Settings */}
              <section>
                <h2 className="font-serif text-2xl mb-4">Branding</h2>
                <div className="space-y-4 max-w-xl">
                  <label className="block">
                    <span className="text-sm text-[#572020]">Name</span>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#E8DDD0] bg-white px-3 py-2"
                      data-testid="input-pub-name"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm text-[#572020]">Tagline</span>
                    <input
                      value={tagline}
                      onChange={(e) => setTagline(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#E8DDD0] bg-white px-3 py-2"
                      data-testid="input-pub-tagline"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm text-[#572020]">Description</span>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={3}
                      className="mt-1 w-full rounded-lg border border-[#E8DDD0] bg-white px-3 py-2"
                      data-testid="input-pub-description"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm text-[#572020]">
                      Accent color (hex, e.g. #8C1515)
                    </span>
                    <input
                      value={accentColor}
                      onChange={(e) => setAccentColor(e.target.value)}
                      placeholder="#8C1515"
                      className="mt-1 w-full rounded-lg border border-[#E8DDD0] bg-white px-3 py-2"
                      data-testid="input-pub-accent"
                    />
                  </label>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => saveSettings.mutate()}
                      disabled={saveSettings.isPending}
                      className="rounded-lg bg-[#8C1515] px-4 py-2 text-white text-sm hover:bg-[#a01a1a] disabled:opacity-60"
                      data-testid="button-save-settings"
                    >
                      {saveSettings.isPending ? "Saving…" : "Save branding"}
                    </button>
                    {settingsMsg && (
                      <span className="text-sm text-[#8a6a5a]">
                        {settingsMsg}
                      </span>
                    )}
                  </div>
                </div>
              </section>

              {/* Welcome email — preview + test send to self */}
              <section>
                <h2 className="font-serif text-2xl mb-1">Welcome email</h2>
                <p className="text-sm text-[#8a6a5a] mb-4 max-w-2xl leading-relaxed">
                  The one-time email a new subscriber receives the moment they
                  confirm — branded with your masthead and accent color. See
                  exactly what readers get, or send a test to your own inbox.
                </p>
                <div className="flex flex-wrap items-center gap-3 mb-3">
                  <button
                    onClick={() => loadWelcome.mutate()}
                    disabled={loadWelcome.isPending}
                    className="rounded-lg bg-[#8C1515] px-4 py-2 text-white text-sm hover:bg-[#a01a1a] disabled:opacity-60"
                    data-testid="button-preview-welcome"
                  >
                    {loadWelcome.isPending
                      ? "Loading…"
                      : welcomeHtml
                        ? "Refresh preview"
                        : "Preview welcome email"}
                  </button>
                  <button
                    onClick={() => sendWelcomeTest.mutate()}
                    disabled={sendWelcomeTest.isPending}
                    className="rounded-lg border border-[#E8DDD0] bg-white px-4 py-2 text-[#572020] text-sm hover:border-[#8C1515] disabled:opacity-60"
                    data-testid="button-send-welcome-test"
                  >
                    {sendWelcomeTest.isPending ? "Sending…" : "Send test to me"}
                  </button>
                  {welcomeMsg && (
                    <span
                      className="text-sm text-[#8a6a5a]"
                      data-testid="text-welcome-msg"
                    >
                      {welcomeMsg}
                    </span>
                  )}
                </div>
                {welcomeHtml && (
                  <div className="rounded-lg border border-[#E8DDD0] bg-white overflow-hidden max-w-2xl">
                    <iframe
                      srcDoc={welcomeHtml}
                      title="Welcome email preview"
                      className="w-full h-[520px] bg-white"
                      sandbox=""
                      data-testid="iframe-welcome-preview"
                    />
                  </div>
                )}
              </section>

              {/* Landing page — Topic → auto-generated, then editable */}
              <section>
                <h2 className="font-serif text-2xl mb-1">Landing page</h2>
                <p className="text-sm text-[#8a6a5a] mb-4 max-w-2xl leading-relaxed">
                  Set a topic and we'll draft a rich editorial landing page for{" "}
                  <span className="font-mono">/p/{pub.slug}</span> — hero, an
                  "about this topic" lead, a few sections and a "what you'll
                  get" band. Everything below is fully editable. Re-generating
                  replaces the current draft.
                </p>

                <div className="flex flex-wrap items-stretch gap-2 max-w-2xl mb-4">
                  <input
                    value={topic}
                    onChange={(e) => {
                      setTopic(e.target.value);
                      setLandingMsg(null);
                    }}
                    placeholder="e.g. Circadian rhythm and shift work"
                    className="flex-1 min-w-[260px] rounded-lg border border-[#E8DDD0] bg-white px-3 py-2 text-sm"
                    data-testid="input-landing-topic"
                  />
                  <button
                    onClick={() => generateLanding.mutate()}
                    disabled={
                      generateLanding.isPending || topic.trim().length < 2
                    }
                    className="rounded-lg bg-[#8C1515] px-4 py-2 text-white text-sm hover:bg-[#a01a1a] disabled:opacity-60"
                    data-testid="button-generate-landing"
                  >
                    {generateLanding.isPending
                      ? "Generating…"
                      : landing
                        ? "Re-generate"
                        : "Generate"}
                  </button>
                </div>

                {landing && (
                  <div className="space-y-5 max-w-2xl">
                    <LandingFieldRow
                      label="Hero eyebrow"
                      value={landing.heroEyebrow}
                      onChange={(v) =>
                        setLanding({ ...landing, heroEyebrow: v })
                      }
                    />
                    <LandingFieldRow
                      label="Hero headline"
                      value={landing.heroHeadline}
                      onChange={(v) =>
                        setLanding({ ...landing, heroHeadline: v })
                      }
                    />
                    <LandingFieldRow
                      label="Hero subhead"
                      value={landing.heroSubhead}
                      textarea
                      onChange={(v) =>
                        setLanding({ ...landing, heroSubhead: v })
                      }
                    />
                    <LandingFieldRow
                      label="About this topic (lead)"
                      value={landing.aboutLead}
                      textarea
                      onChange={(v) => setLanding({ ...landing, aboutLead: v })}
                    />

                    {/* Hero image */}
                    <LandingImageRow
                      label="Hero image"
                      imagePath={heroImagePath}
                      promptValue={landing.heroEyebrow}
                      busy={regenImage.isPending}
                      onRegen={(prompt) =>
                        regenImage.mutate({ target: "hero", prompt })
                      }
                    />

                    {/* Sections */}
                    <div className="space-y-4">
                      <p className="text-sm font-medium text-[#572020]">
                        Sections
                      </p>
                      {landing.sections.map((s, i) => (
                        <div
                          key={i}
                          className="rounded-xl border border-[#E8DDD0] bg-[#FBF7F0] p-4 space-y-3"
                        >
                          <LandingFieldRow
                            label={`Section ${i + 1} heading`}
                            value={s.heading}
                            onChange={(v) =>
                              setLanding({
                                ...landing,
                                sections: landing.sections.map((x, j) =>
                                  j === i ? { ...x, heading: v } : x,
                                ),
                              })
                            }
                          />
                          <LandingFieldRow
                            label="Body"
                            value={s.body}
                            textarea
                            onChange={(v) =>
                              setLanding({
                                ...landing,
                                sections: landing.sections.map((x, j) =>
                                  j === i ? { ...x, body: v } : x,
                                ),
                              })
                            }
                          />
                          <LandingImageRow
                            label="Section image"
                            imagePath={s.imagePath}
                            promptValue={s.imagePrompt ?? s.heading}
                            busy={regenImage.isPending}
                            onRegen={(prompt) =>
                              regenImage.mutate({ target: i, prompt })
                            }
                          />
                        </div>
                      ))}
                    </div>

                    {/* What you'll get */}
                    <div className="space-y-2">
                      <p className="text-sm font-medium text-[#572020]">
                        What you'll get
                      </p>
                      {landing.benefits.map((b, i) => (
                        <div key={i} className="flex items-start gap-2">
                          <textarea
                            value={b}
                            rows={2}
                            onChange={(e) =>
                              setLanding({
                                ...landing,
                                benefits: landing.benefits.map((x, j) =>
                                  j === i ? e.target.value : x,
                                ),
                              })
                            }
                            className="flex-1 rounded-lg border border-[#E8DDD0] bg-white px-3 py-2 text-sm"
                            data-testid={`input-landing-benefit-${i}`}
                          />
                          <button
                            onClick={() =>
                              setLanding({
                                ...landing,
                                benefits: landing.benefits.filter(
                                  (_, j) => j !== i,
                                ),
                              })
                            }
                            className="rounded-lg border border-[#E8DDD0] px-2 py-2 text-sm text-[#8a6a5a] hover:text-[#E8352A]"
                            aria-label="Remove benefit"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={() =>
                          setLanding({
                            ...landing,
                            benefits: [...landing.benefits, ""],
                          })
                        }
                        className="text-sm text-[#8C1515] hover:underline"
                      >
                        + Add point
                      </button>
                    </div>

                    <div className="flex items-center gap-3 pt-1">
                      <button
                        onClick={() => saveLanding.mutate()}
                        disabled={saveLanding.isPending}
                        className="rounded-lg bg-[#8C1515] px-4 py-2 text-white text-sm hover:bg-[#a01a1a] disabled:opacity-60"
                        data-testid="button-save-landing"
                      >
                        {saveLanding.isPending
                          ? "Saving…"
                          : "Save landing page"}
                      </button>
                      <a
                        href={publicUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-[#8C1515] hover:underline"
                      >
                        Preview
                      </a>
                    </div>
                  </div>
                )}

                {landingMsg && (
                  <p
                    className={`text-sm mt-3 ${
                      /saved|generated|updated/i.test(landingMsg)
                        ? "text-[#2e7d32]"
                        : "text-[#8a6a5a]"
                    }`}
                    data-testid="text-landing-msg"
                  >
                    {landingMsg}
                  </p>
                )}
              </section>

              {/* Subscribers */}
              <section>
                <div className="flex items-baseline justify-between mb-4">
                  <h2 className="font-serif text-2xl">Subscribers</h2>
                  <span className="text-sm text-[#8a6a5a]">
                    {subsQuery.data?.counts.active ?? 0} active ·{" "}
                    {subsQuery.data?.counts.total ?? 0} total
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 mb-4">
                  <input
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="email@example.com"
                    className="flex-1 min-w-[200px] rounded-lg border border-[#E8DDD0] bg-white px-3 py-2"
                    data-testid="input-sub-email"
                  />
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Name (optional)"
                    className="flex-1 min-w-[160px] rounded-lg border border-[#E8DDD0] bg-white px-3 py-2"
                    data-testid="input-sub-name"
                  />
                  <button
                    onClick={() => addSub.mutate()}
                    disabled={addSub.isPending || !newEmail.trim()}
                    className="rounded-lg bg-[#8C1515] px-4 py-2 text-white text-sm hover:bg-[#a01a1a] disabled:opacity-60"
                    data-testid="button-add-subscriber"
                  >
                    Add
                  </button>
                </div>
                <div className="rounded-xl border border-[#E8DDD0] overflow-hidden">
                  {(subsQuery.data?.subscribers ?? []).length === 0 ? (
                    <p className="text-sm text-[#8a6a5a] p-4">
                      No subscribers yet. Share your signup link above.
                    </p>
                  ) : (
                    (subsQuery.data?.subscribers ?? []).map((s) => (
                      <div
                        key={s.id}
                        className="flex items-center justify-between gap-3 border-b border-[#E8DDD0] last:border-0 bg-white px-4 py-2.5"
                        data-testid={`subscriber-${s.id}`}
                      >
                        <div className="min-w-0">
                          <p className="text-sm text-[#572020] truncate">
                            {s.email}
                          </p>
                          {s.name && (
                            <p className="text-xs text-[#8a6a5a] truncate">
                              {s.name}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-3 flex-none">
                          {s.status !== "active" && (
                            <span className="text-[11px] text-[#8a6a5a]">
                              {s.status}
                            </span>
                          )}
                          <button
                            onClick={() => deleteSub.mutate(s.id)}
                            className="text-xs text-[#E8352A] hover:underline"
                            data-testid={`button-delete-subscriber-${s.id}`}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>

              {/* Issues */}
              <section>
                <h2 className="font-serif text-2xl mb-4">Issues</h2>
                <div className="flex flex-wrap gap-2 mb-4">
                  <input
                    value={newIssueTitle}
                    onChange={(e) => setNewIssueTitle(e.target.value)}
                    placeholder="New issue title"
                    className="flex-1 min-w-[220px] rounded-lg border border-[#E8DDD0] bg-white px-3 py-2"
                    data-testid="input-new-issue-title"
                  />
                  <button
                    onClick={() => createIssue.mutate()}
                    disabled={createIssue.isPending}
                    className="rounded-lg bg-[#8C1515] px-4 py-2 text-white text-sm hover:bg-[#a01a1a] disabled:opacity-60"
                    data-testid="button-create-issue"
                  >
                    {createIssue.isPending ? "Creating…" : "New issue"}
                  </button>
                </div>
                <div className="space-y-2">
                  {(issuesQuery.data?.issues ?? []).length === 0 ? (
                    <p className="text-sm text-[#8a6a5a]">No issues yet.</p>
                  ) : (
                    (issuesQuery.data?.issues ?? []).map((i) => (
                      <div
                        key={i.id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-[#E8DDD0] bg-white px-4 py-3"
                        data-testid={`issue-${i.id}`}
                      >
                        <button
                          onClick={() => setOpenIssue(i.id)}
                          className="text-left min-w-0"
                          data-testid={`button-open-issue-${i.id}`}
                        >
                          <p className="text-[#572020] font-medium truncate">
                            {i.title}
                          </p>
                          <p className="text-xs text-[#8a6a5a]">
                            {i.status === "sent"
                              ? `Sent to ${i.recipientCount ?? 0}`
                              : "Draft"}
                          </p>
                        </button>
                        {i.status === "sent" ? (
                          <div className="flex items-center gap-3 flex-none">
                            <a
                              href={`${publicUrl}/${i.id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs text-[#8C1515] hover:underline"
                              data-testid={`link-view-public-issue-${i.id}`}
                            >
                              View
                            </a>
                            <button
                              onClick={() => {
                                void navigator.clipboard?.writeText(
                                  `${publicUrl}/${i.id}`,
                                );
                                setCopiedIssueId(i.id);
                                setTimeout(() => setCopiedIssueId(null), 1500);
                              }}
                              className="text-xs rounded border border-[#E8DDD0] bg-white px-2.5 py-1 hover:border-[#8C1515]"
                              data-testid={`button-copy-issue-link-${i.id}`}
                            >
                              {copiedIssueId === i.id ? "Copied" : "Copy link"}
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => deleteIssue.mutate(i.id)}
                            className="text-xs text-[#E8352A] hover:underline flex-none"
                            data-testid={`button-delete-issue-${i.id}`}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          )}
        </>
      )}
    </PortalShell>
  );
}

type PillarTab = "status" | "pulls" | "invites" | "technical" | "browse";

function TabGuide({
  eyebrow,
  title,
  why,
  steps,
}: {
  eyebrow: string;
  title: string;
  why: string;
  steps: string[];
}) {
  return (
    <section
      className="mb-8 rounded-2xl border border-[#E8DDD0] bg-gradient-to-br from-[#F9F5EE] to-[#F4ECDD] p-6"
      data-testid="tab-guide"
    >
      <p className="text-[10px] tracking-[0.25em] text-[#8C1515] uppercase mb-2">
        {eyebrow}
      </p>
      <h2 className="font-serif text-2xl text-[#572020] mb-2">{title}</h2>
      <p className="text-sm text-[#8a6a5a] max-w-2xl leading-relaxed mb-5">
        {why}
      </p>
      <ol
        className={`grid gap-3 ${
          steps.length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3"
        }`}
      >
        {steps.map((s, i) => (
          <li
            key={i}
            className="flex items-start gap-3 rounded-xl bg-white/60 border border-[#E8DDD0] p-3"
          >
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[#8C1515] text-white text-xs font-medium flex items-center justify-center">
              {i + 1}
            </span>
            <span className="text-sm text-[#572020] leading-snug">{s}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function PillarDetail() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const { data, isLoading, error } = useQuery<{
    id: number;
    slug: string;
    name: string;
    description: string | null;
    role: string | null;
  }>({
    queryKey: ["faculty-pillar", slug],
    queryFn: () => fetchJson(`/api/faculty/pillars/${slug}`),
  });

  const { data: me } = useMe();
  const qc = useQueryClient();
  const [tab, setTab] = useState<PillarTab>("status");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<
    "steward" | "contributor" | "advisor" | "viewer"
  >("contributor");
  const [inviteInstitution, setInviteInstitution] = useState("");
  const [inviteMsg, setInviteMsg] = useState<string | null>(null);

  const inviteMutation = useMutation({
    mutationFn: (vars: {
      email: string;
      role: string;
      pillarId: number;
      institution?: string;
    }) =>
      fetchJson<{ email: string; role: string }>("/api/faculty/invitations", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: (r) => {
      setInviteMsg(`Sent invite to ${r.email} as ${r.role}.`);
      setInviteEmail("");
      setInviteInstitution("");
      qc.invalidateQueries({ queryKey: ["faculty-me"] });
    },
    onError: (e: Error) => setInviteMsg(`Error: ${e.message}`),
  });

  if (isLoading)
    return (
      <PortalShell>
        <p className="text-[#8a6a5a]">Loading…</p>
      </PortalShell>
    );
  if (error)
    return (
      <PortalShell>
        <p className="text-[#E8352A]">{(error as Error).message}</p>
      </PortalShell>
    );
  if (!data) return null;

  const canInvite = data.role === "steward" || me?.user.isPlatformAdmin;
  const isSteward = data.role === "steward";

  const tabs: Array<{ id: PillarTab; label: string }> = [
    { id: "status", label: "Status quo" },
    { id: "pulls", label: "Pull requests" },
    ...(canInvite ? [{ id: "invites" as const, label: "Invitations" }] : []),
    { id: "technical", label: "Technical" },
    { id: "browse", label: "Browse pillars" },
  ];

  const activeTab: PillarTab = tab === "invites" && !canInvite ? "status" : tab;

  return (
    <PortalShell>
      <Link
        href="/dashboard"
        className="text-sm text-[#8a6a5a] hover:text-[#572020]"
      >
        ← All pillars
      </Link>
      <div className="mt-4 mb-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-[10px] tracking-[0.25em] text-[#8C1515] uppercase mb-2">
              {data.role} · pillar
            </p>
            <h1 className="font-serif text-4xl font-medium mb-3">
              {data.name}
            </h1>
            {data.description && (
              <p className="text-[#8a6a5a] max-w-2xl">{data.description}</p>
            )}
          </div>
          {isSteward && (
            <Link
              href={`/pillars/${slug}/coach-videos`}
              className="shrink-0 inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-full border border-[#E8DDD0] text-[#8a6a5a] hover:border-[#8C1515] hover:text-[#8C1515] transition-colors"
              data-testid="link-coach-videos"
            >
              Coach videos &#8594;
            </Link>
          )}
        </div>
      </div>

      <div
        className="flex flex-wrap gap-2 mb-8 border-b border-[#E8DDD0] pb-3"
        role="tablist"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            onClick={() => setTab(t.id)}
            className={`text-sm px-4 py-1.5 rounded-full border transition ${
              activeTab === t.id
                ? "border-[#8C1515] text-[#8C1515] bg-[#8C1515]/5"
                : "border-[#E8DDD0] text-[#8a6a5a] hover:border-[#8C1515]"
            }`}
            data-testid={`pillar-tab-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "status" && (
        <div data-testid="tab-panel-status">
          <TabGuide
            eyebrow="You are here"
            title="Your pillar at a glance"
            why={`This is your home base for ${data.name}. Keep your library current, clear what's waiting on your sign-off, and track what you've earned.`}
            steps={[
              "Clear interpretations waiting in your review queue",
              "Keep your knowledge library current",
            ]}
          />

          {isSteward && (
            <section className="border border-[#E8DDD0] rounded-xl p-6 mb-8">
              <h2 className="font-serif text-lg mb-2">Steward review queue</h2>
              <p className="text-sm text-[#8a6a5a] mb-4">
                Faculty interpretations waiting on your approval.
              </p>
              <Link
                href={`/pillars/${data.slug}/inbox`}
                className="inline-block bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition"
                data-testid="link-inbox"
              >
                Open review queue →
              </Link>
            </section>
          )}

          <section className="border border-[#E8DDD0] rounded-xl p-6 mb-8">
            <h2 className="font-serif text-lg mb-2">Knowledge library</h2>
            <p className="text-sm text-[#8a6a5a] mb-4">
              Papers, Stanford Lifestyle Medicine articles, and notes that feed
              this pillar's answers.
            </p>
            <Link
              href={`/pillars/${data.slug}/library`}
              className="inline-block bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] transition"
              data-testid="link-library"
            >
              Open library →
            </Link>
          </section>
        </div>
      )}

      {activeTab === "pulls" && (
        <div data-testid="tab-panel-pulls">
          <TabGuide
            eyebrow="Collaborate"
            title="Share answers across pillars"
            why="Like pull requests in code: another steward can ask to adopt one of your published answers into their pillar, and you can ask to adopt theirs — always with the owner's sign-off."
            steps={[
              "Review adoption requests sent to you",
              "Approve to add an attributed answer",
              "Propose adopting another pillar's answer",
            ]}
          />
          <MergeRequestsBody embedded />
        </div>
      )}

      {activeTab === "invites" && (
        <div data-testid="tab-panel-invites">
          <TabGuide
            eyebrow="Grow the team"
            title="Bring colleagues onto this pillar"
            why="You don't have to be the only voice. Invite co-stewards, contributors, or advisors to help build and review this pillar."
            steps={[
              "Enter a colleague's email",
              "Choose what they can do",
              "Send the invitation",
            ]}
          />
          <section className="border border-[#E8DDD0] rounded-xl p-6">
            <h2 className="font-serif text-lg mb-4">Invite a contributor</h2>
            <div className="flex flex-col gap-3 max-w-lg">
              <input
                type="email"
                required
                placeholder="email@stanford.edu"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="bg-white border border-[#E8DDD0] rounded-lg px-4 py-2 text-[#572020]"
                data-testid="input-invite-email"
              />
              <select
                value={inviteRole}
                onChange={(e) =>
                  setInviteRole(
                    e.target.value as
                      | "steward"
                      | "contributor"
                      | "advisor"
                      | "viewer",
                  )
                }
                className="bg-white border border-[#E8DDD0] rounded-lg px-4 py-2 text-[#572020]"
                data-testid="select-invite-role"
              >
                <option value="steward">Steward</option>
                <option value="contributor">Contributor</option>
                <option value="advisor">Advisor (cross-pillar lens)</option>
                <option value="viewer">Viewer</option>
              </select>
              <input
                type="text"
                placeholder="Institution (optional) — e.g. Stanford Medicine"
                value={inviteInstitution}
                onChange={(e) => setInviteInstitution(e.target.value)}
                className="bg-white border border-[#E8DDD0] rounded-lg px-4 py-2 text-[#572020]"
                data-testid="input-invite-institution"
              />
              <p className="text-xs text-[#8a6a5a] -mt-1">
                For outside researchers — shown as a “from [Institution]” byline
                credit. Leave blank for Stanford / name-only.
              </p>
              <button
                onClick={() =>
                  inviteEmail &&
                  inviteMutation.mutate({
                    email: inviteEmail,
                    role: inviteRole,
                    pillarId: data.id,
                    institution: inviteInstitution.trim() || undefined,
                  })
                }
                disabled={inviteMutation.isPending || !inviteEmail}
                className="bg-[#8C1515] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#a01a1a] disabled:opacity-50 transition w-fit"
                data-testid="button-send-invite"
              >
                {inviteMutation.isPending ? "Sending…" : "Send invitation"}
              </button>
              {inviteMsg && (
                <p
                  className="text-sm text-[#8a6a5a]"
                  data-testid="text-invite-msg"
                >
                  {inviteMsg}
                </p>
              )}
            </div>
          </section>
        </div>
      )}

      {activeTab === "technical" && (
        <div data-testid="tab-panel-technical">
          <TabGuide
            eyebrow="Go live"
            title="Put your agent on your own site"
            why="Your expert agent can live anywhere — your lab page, your homepage, a blog post. Copy a snippet, paste it in, and readers can ask it questions."
            steps={[
              "Copy the embed snippet below",
              "Paste it into your website",
              "Readers can ask your agent questions right there",
            ]}
          />
          <EmbedSnippetCard slug={data.slug} pillarName={data.name} />
          <LiveAgentSnippetCard
            slug={data.slug}
            pillarName={data.name}
            expertName={me?.user?.fullName ?? null}
          />
        </div>
      )}

      {activeTab === "browse" && (
        <div data-testid="tab-panel-browse">
          <TabGuide
            eyebrow="Explore"
            title="See every pillar's published work"
            why="A read-only view of approved answers across the platform. Find work to learn from, discuss, or adopt into your own pillar."
            steps={[
              "Filter to a pillar that interests you",
              "Open an answer to read it in full",
              "Start a discussion or propose adopting it",
            ]}
          />
          <CrossPillarBrowserBody embedded />
        </div>
      )}
    </PortalShell>
  );
}

// ---------- Coverage dashboard ----------

interface CoverageDashboardData {
  pillar: { id: number; slug: string; name: string };
  totals: { total: number; uncovered: number; flagged: number };
  clusters: Array<{
    id: number;
    representativeQuestion: string;
    size: number;
    lastUpdated: string;
    memberQuestions: string[];
  }>;
  lowConfidence: Array<{
    id: string;
    question: string;
    topScore: number;
    userFlagged: boolean;
    flagReason: string | null;
    createdAt: string;
  }>;
  topTopics: Array<{ sourceId: number; title: string; count: number }>;
  // Honest, windowed unanswered backlog (clustered + still-ungrouped demand),
  // reconciled against `totalUncovered`. Mirrors the /gaps surface so the
  // dashboard never hides freshly-asked or aged-out questions.
  gaps: {
    windowDays: number;
    totalUncovered: number;
    distinctQuestions: number;
    clusters: Array<{
      id: number;
      representativeQuestion: string;
      askedInWindow: number;
      lastUpdated: string;
      memberQuestions: string[];
    }>;
    ungroupedUncovered: Array<{
      question: string;
      count: number;
      lastAsked: string;
    }>;
  };
}

function ClusterPromoteWidget({
  slug,
  clusterId,
  variant = "link",
}: {
  slug: string;
  clusterId: number;
  // "link" = the compact inline trigger used inside lists; "primary" = a
  // prominent cardinal button for the guided dashboard's headline next move.
  // Both expand into the identical pick/upload panel below.
  variant?: "link" | "primary";
}) {
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"pick" | "upload">("pick");
  const [picking, setPicking] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadKind, setUploadKind] = useState<
    "paper" | "slm_article" | "talk" | "note"
  >("note");
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadText, setUploadText] = useState("");
  const [uploading, setUploading] = useState(false);

  const suggestions = useQuery<{
    suggestions: Array<{ sourceId: number; title: string; score: number }>;
  }>({
    queryKey: ["cluster-source-suggestions", slug, clusterId],
    queryFn: () =>
      fetchJson(
        `/api/faculty/pillars/${slug}/clusters/${clusterId}/source-suggestions`,
      ),
    enabled: open,
  });

  async function promote(sourceId: number): Promise<void> {
    setPicking(sourceId);
    setError(null);
    try {
      const result = await fetchJson<{
        interpretationId: number;
        sourceId: number;
        pillarSlug: string;
      }>(`/api/faculty/pillars/${slug}/clusters/${clusterId}/promote`, {
        method: "POST",
        body: JSON.stringify({ sourceId }),
      });
      setLocation(
        `/pillars/${result.pillarSlug}/sources/${result.sourceId}?interp=${result.interpretationId}`,
      );
    } catch (e) {
      setError((e as Error).message ?? "Promotion failed");
      setPicking(null);
      throw e;
    }
  }

  async function uploadAndPromote(): Promise<void> {
    setError(null);
    if (!uploadFile && !uploadText.trim()) {
      setError("Attach a PDF or paste text from the source");
      return;
    }
    if (!uploadTitle.trim() && !uploadFile) {
      setError("Add a title");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("kind", uploadKind);
      if (uploadTitle.trim()) fd.append("title", uploadTitle.trim());
      if (uploadFile) fd.append("file", uploadFile);
      if (uploadText.trim()) fd.append("text", uploadText.trim());
      const res = await fetch(`/api/faculty/pillars/${slug}/sources`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `Upload failed (${res.status})`);
      }
      const created = (await res.json()) as { id: number };
      await promote(created.id);
    } catch (e) {
      setError((e as Error).message ?? "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  if (!open) {
    if (variant === "primary") {
      return (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setMode("pick");
          }}
          className="inline-flex items-center gap-2 rounded-full bg-[#8C1515] px-7 py-3 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[#a01a1a]"
          data-testid={`button-write-interpretation-${clusterId}`}
        >
          <span aria-hidden>＋</span> Write this answer →
        </button>
      );
    }
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setMode("pick");
        }}
        className="inline-block mt-3 text-xs text-[#E8352A] hover:underline"
        data-testid={`button-write-interpretation-${clusterId}`}
      >
        Write interpretation →
      </button>
    );
  }

  const list = suggestions.data?.suggestions ?? [];
  const noMatches = !suggestions.isLoading && list.length === 0;

  return (
    <div
      className="mt-3 border-t border-[#E8DDD0] pt-3"
      data-testid={`promote-widget-${clusterId}`}
    >
      {mode === "pick" && (
        <>
          <p className="text-[10px] tracking-[0.2em] uppercase text-[#8a6a5a] mb-2">
            Pick the source this answer should hang off
          </p>
          {suggestions.isLoading ? (
            <p className="text-xs text-[#8a6a5a]">Finding likely sources…</p>
          ) : noMatches ? (
            <p className="text-xs text-[#8a6a5a]">
              No source in this pillar matched well.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {list.map((s) => (
                <li key={s.sourceId}>
                  <button
                    type="button"
                    disabled={picking !== null}
                    onClick={() => promote(s.sourceId)}
                    className="w-full text-left text-xs text-[#572020] hover:text-[#E8352A] hover:underline disabled:opacity-50"
                    data-testid={`button-promote-source-${clusterId}-${s.sourceId}`}
                  >
                    · {s.title}{" "}
                    <span className="text-[#666]">
                      ({Math.round(s.score * 100)}% match)
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => {
              setMode("upload");
              setError(null);
            }}
            className="text-[11px] text-[#E8352A] hover:underline mt-3 block"
            data-testid={`button-pivot-upload-${clusterId}`}
          >
            {noMatches
              ? "Upload a source instead →"
              : "None of these — upload a new source →"}
          </button>
        </>
      )}

      {mode === "upload" && (
        <div data-testid={`upload-pivot-${clusterId}`}>
          <p className="text-[10px] tracking-[0.2em] uppercase text-[#8a6a5a] mb-2">
            Upload a new source
          </p>
          <div className="grid gap-2">
            <select
              value={uploadKind}
              onChange={(e) =>
                setUploadKind(e.target.value as typeof uploadKind)
              }
              className="bg-white border border-[#E8DDD0] rounded px-2 py-1 text-xs"
              data-testid={`select-upload-kind-${clusterId}`}
            >
              <option value="note">Note</option>
              <option value="paper">Paper</option>
              <option value="slm_article">SLM article</option>
              <option value="talk">Talk or transcript</option>
            </select>
            <input
              placeholder="Title (optional if PDF)"
              value={uploadTitle}
              onChange={(e) => setUploadTitle(e.target.value)}
              className="bg-white border border-[#E8DDD0] rounded px-2 py-1 text-xs"
              data-testid={`input-upload-title-${clusterId}`}
            />
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
              className="text-xs text-[#8a6a5a]"
              data-testid={`input-upload-file-${clusterId}`}
            />
            <textarea
              placeholder="…or paste source text"
              value={uploadText}
              onChange={(e) => setUploadText(e.target.value)}
              rows={3}
              className="bg-white border border-[#E8DDD0] rounded px-2 py-1 text-xs"
              data-testid={`input-upload-text-${clusterId}`}
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={uploading || picking !== null}
                onClick={uploadAndPromote}
                className="bg-[#8C1515] text-white text-xs px-3 py-1.5 rounded hover:bg-[#a01a1a] disabled:opacity-50"
                data-testid={`button-upload-and-promote-${clusterId}`}
              >
                {uploading || picking !== null
                  ? "Uploading…"
                  : "Upload & start interpretation"}
              </button>
              <button
                type="button"
                disabled={uploading}
                onClick={() => {
                  setMode("pick");
                  setError(null);
                }}
                className="text-[11px] text-[#8a6a5a] hover:text-[#572020]"
              >
                Back
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-[#E8352A] mt-2">{error}</p>}
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setMode("pick");
          setError(null);
        }}
        className="text-[10px] text-[#666] hover:text-[#8a6a5a] mt-2 block"
      >
        Cancel
      </button>
    </div>
  );
}

// ---------- Unanswered questions (the secured RAG couldn't answer) ----------

interface GapsData {
  pillar: { id: number; slug: string; name: string };
  windowDays: number;
  totalUncovered: number;
  distinctQuestions: number;
  clusters: Array<{
    id: number;
    representativeQuestion: string;
    askedInWindow: number;
    lastUpdated: string;
    memberQuestions: string[];
  }>;
  ungroupedUncovered: Array<{
    question: string;
    count: number;
    lastAsked: string;
  }>;
}

function gapsTimeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

function DemandFeedItemCluster({
  c,
  slug,
  windowDays,
  canPromote,
}: {
  c: GapsData["clusters"][0];
  slug: string;
  windowDays: number;
  canPromote: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const variants = c.memberQuestions.filter(
    (q) => q !== c.representativeQuestion,
  );
  const hasVariants = variants.length > 0;

  return (
    <div
      className="group relative flex flex-col sm:flex-row gap-4 sm:gap-6 p-5 sm:p-6 transition-all duration-300 hover:bg-white/60 bg-transparent border-b border-[#E8DDD0] last:border-0"
      data-testid={`gaps-cluster-${c.id}`}
    >
      <div className="flex-shrink-0 pt-1">
        <span className="inline-flex h-10 min-w-10 px-3 items-center justify-center rounded-full bg-gradient-to-b from-[#F4ECDD] to-[#F0E8DD] text-[#8C1515] text-sm font-medium border border-[#E8DDD0] shadow-sm transition-transform group-hover:scale-105">
          {c.askedInWindow}×
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <span className="text-[10px] uppercase tracking-[0.15em] text-[#8C1515] font-medium bg-[#8C1515]/5 border border-[#8C1515]/10 px-2 py-0.5 rounded-full">
            Ready to Answer
          </span>
          <span className="text-xs text-[#8a6a5a]">
            Asked {c.askedInWindow} times in {windowDays} days
          </span>
        </div>
        <p className="text-[#572020] font-serif text-[17px] leading-snug mb-3">
          “{c.representativeQuestion}”
        </p>

        {hasVariants && (
          <div className="mb-4">
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-[#8a6a5a] hover:text-[#8C1515] transition-colors flex items-center gap-1.5"
            >
              <svg
                className={`w-3 h-3 transform transition-transform ${expanded ? "rotate-90" : ""}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
              {variants.length} variant{variants.length !== 1 ? "s" : ""}
            </button>
            <div
              className={`grid transition-all duration-300 ease-in-out ${
                expanded
                  ? "grid-rows-[1fr] opacity-100 mt-2"
                  : "grid-rows-[0fr] opacity-0"
              }`}
            >
              <ul className="overflow-hidden space-y-1.5 border-l-2 border-[#E8DDD0] pl-3 ml-1.5">
                {variants.map((q, i) => (
                  <li
                    key={i}
                    className="text-xs text-[#7a5a4a] leading-relaxed"
                  >
                    “{q}”
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <div className="mt-2">
          {canPromote ? (
            <ClusterPromoteWidget slug={slug} clusterId={c.id} variant="link" />
          ) : (
            <p className="text-xs text-[#8a6a5a] italic">
              A steward can turn this into an answer.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function DemandFeedItemUngrouped({
  u,
  slug,
  canPromote,
  index,
}: {
  u: GapsData["ungroupedUncovered"][0];
  slug: string;
  canPromote: boolean;
  index: number;
}) {
  const inner = (
    <div
      className="group relative flex flex-col sm:flex-row gap-4 sm:gap-6 p-5 sm:p-6 transition-all duration-300 hover:bg-white/60 bg-transparent border-b border-[#E8DDD0] last:border-0"
      data-testid={`gaps-ungrouped-${index}`}
    >
      <div className="flex-shrink-0 pt-1">
        <span className="inline-flex h-10 min-w-10 px-3 items-center justify-center rounded-full bg-white text-[#8a6a5a] text-sm font-medium border border-[#E8DDD0] shadow-sm opacity-80 transition-all group-hover:opacity-100 group-hover:scale-105">
          {u.count}×
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <span className="text-[10px] uppercase tracking-[0.15em] text-[#8a6a5a] bg-white border border-[#E8DDD0] px-2 py-0.5 rounded-full">
            Just Arrived
          </span>
          <span className="text-xs text-[#8a6a5a]">
            Last asked {gapsTimeAgo(u.lastAsked)}
          </span>
        </div>
        <p className="text-[#572020] text-[15px] leading-relaxed mb-3 pr-8">
          “{u.question}”
        </p>

        {canPromote && (
          <div className="inline-flex items-center text-xs font-medium text-[#8C1515] opacity-0 group-hover:opacity-100 transform -translate-x-2 group-hover:translate-x-0 transition-all duration-300">
            Write quick answer <span className="ml-1">→</span>
          </div>
        )}
      </div>
    </div>
  );

  if (canPromote) {
    return (
      <Link
        href={`/answer?slug=${encodeURIComponent(slug)}&q=${encodeURIComponent(u.question)}`}
        className="block no-underline"
      >
        {inner}
      </Link>
    );
  }

  return inner;
}

// Dedicated, full backlog of every reader question the secured/governed RAG
// could NOT answer for a pillar, over a selectable window. The dashboard only
// previews the hottest few; this is the complete, actionable surface. Grouped
// gaps carry a clusterId and reuse the same promote flow as the dashboard;
// freshly-arrived questions that the hourly cluster job hasn't grouped yet are
// shown read-only so nothing is hidden. Every count is a real windowed count.
function GapsPage() {
  const { data: me, isLoading: meLoading, error: meError } = useMe();
  const viewAs = useViewAs();
  const [slug, setSlug] = useState<string | null>(null);
  const [days, setDays] = useState<7 | 30 | 90>(30);

  // Honor a ?slug= deep-link (e.g. the "See all unanswered" link on the Quick
  // Answer page) once the roster has loaded, but only if the caller can open
  // that pillar. After that, the picker drives the selection.
  const slugInitRef = useRef(false);

  const isAdmin = me?.user.isPlatformAdmin ?? false;
  const roleByPillarId = new Map(
    (me?.memberships ?? []).map((m) => [m.pillarId, m.role]),
  );
  // Pillars the steward can open here: admins see all; everyone else sees the
  // pillars they belong to. (The endpoint allows viewers to read.)
  const selectablePillars = (me?.pillars ?? [])
    .filter((p) => isAdmin || roleByPillarId.has(p.id))
    .map((p) => ({
      ...p,
      role: roleByPillarId.get(p.id) ?? (isAdmin ? "admin" : "viewer"),
    }));

  // Default to a pillar the user actually stewards, else the first available.
  const defaultSlug =
    selectablePillars.find((p) => p.role === "steward")?.slug ??
    selectablePillars[0]?.slug ??
    null;
  useEffect(() => {
    if (slugInitRef.current || selectablePillars.length === 0) return;
    slugInitRef.current = true;
    const wanted = qaInitialParam("slug");
    if (wanted && selectablePillars.some((p) => p.slug === wanted)) {
      setSlug(wanted);
    }
  }, [selectablePillars]);

  const activeSlug = slug ?? defaultSlug;
  const activePillar = selectablePillars.find((p) => p.slug === activeSlug);
  // Promote needs steward/contributor (admins bypass the role gate server-side).
  // A viewer — or anyone in read-only preview — sees the gaps but no dead CTA.
  const canPromote =
    !viewAs &&
    (isAdmin ||
      activePillar?.role === "steward" ||
      activePillar?.role === "contributor");

  const gaps = useQuery<GapsData>({
    queryKey: ["faculty-gaps-page", activeSlug, days],
    queryFn: () =>
      fetchJson(`/api/faculty/pillars/${activeSlug}/gaps?days=${days}`),
    enabled: !!activeSlug,
  });

  if (meLoading) {
    return (
      <PortalShell>
        <p className="text-[#8a6a5a]">Loading…</p>
      </PortalShell>
    );
  }
  if (meError) {
    return (
      <PortalShell>
        <p className="text-[#E8352A]">{(meError as Error).message}</p>
      </PortalShell>
    );
  }
  if (selectablePillars.length === 0) {
    return (
      <PortalShell>
        <SectionEyebrow
          icon={<IconCompass />}
          label="Unanswered"
          tone="cardinal"
        />
        <h1 className="font-serif text-3xl font-medium mb-2">
          Unanswered questions
        </h1>
        <p className="text-[#8a6a5a]">
          You don’t steward a pillar yet, so there’s no reader backlog to show.
        </p>
      </PortalShell>
    );
  }

  const data = gaps.data;
  return (
    <PortalShell>
      <div className="mb-10 max-w-4xl">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-6">
          <div>
            <SectionEyebrow
              icon={<IconCompass />}
              label="Reader Demand"
              tone="cardinal"
            />
            <h1 className="font-serif text-3xl sm:text-4xl font-medium mt-3 mb-3 text-[#572020]">
              What readers need next
            </h1>
            <p className="text-[#8a6a5a] leading-relaxed max-w-2xl text-sm sm:text-base">
              These are the questions your governed AI couldn’t answer. The
              highest-demand topics rise to the top—turn them into answers to
              expand your pillar’s coverage.
            </p>
          </div>
          {selectablePillars.length > 0 && (
            <div className="flex-shrink-0 flex items-center gap-3 bg-white/50 border border-[#E8DDD0] p-1.5 rounded-xl shadow-sm">
              {selectablePillars.length > 1 && (
                <div className="relative border-r border-[#E8DDD0] pr-1.5">
                  <select
                    value={activeSlug ?? ""}
                    onChange={(e) => setSlug(e.target.value)}
                    className="appearance-none bg-transparent hover:bg-white pl-3 pr-8 py-2 rounded-lg text-sm font-medium text-[#572020] outline-none cursor-pointer transition-colors"
                    data-testid="select-gaps-pillar"
                  >
                    {selectablePillars.map((p) => (
                      <option key={p.id} value={p.slug}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[#8a6a5a]">
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M19 9l-7 7-7-7"
                      ></path>
                    </svg>
                  </div>
                </div>
              )}
              <div className="flex bg-[#F9F5EE] p-0.5 rounded-lg border border-[#E8DDD0]">
                {([7, 30, 90] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDays(d)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                      days === d
                        ? "bg-white text-[#8C1515] shadow-sm border border-[#E8DDD0]"
                        : "text-[#8a6a5a] hover:text-[#572020] border border-transparent"
                    }`}
                    data-testid={`button-gaps-window-${d}`}
                  >
                    {d}d
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {gaps.isLoading && (
          <div className="animate-pulse flex space-x-4 py-6">
            <div className="h-4 bg-[#E8DDD0] rounded w-3/4"></div>
          </div>
        )}
        {gaps.error && (
          <div className="p-4 rounded-lg bg-[#FCEDEB] text-[#E8352A] text-sm border border-[#E8352A]/20">
            Couldn’t load: {(gaps.error as Error).message}
          </div>
        )}

        {data && (
          <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
            {data.totalUncovered === 0 ? (
              <div className="rounded-2xl border border-[#CBE3D1] bg-gradient-to-br from-[#EAF3EC] to-[#F2F9F4] p-8 sm:p-10 shadow-sm text-center sm:text-left flex flex-col sm:flex-row items-center gap-6">
                <div className="flex-shrink-0 h-16 w-16 bg-white rounded-full flex items-center justify-center border border-[#CBE3D1] shadow-sm text-[#2f7d41]">
                  <IconCheck className="h-8 w-8" />
                </div>
                <div>
                  <h2 className="font-serif text-2xl text-[#1f7a3d] mb-2">
                    Perfect coverage
                  </h2>
                  <p className="text-[15px] text-[#2f7d41] max-w-xl leading-relaxed">
                    Your published answers are handling everything readers are
                    asking right now. Widen the time window, or stay ahead by
                    adding new sources to {data.pillar.name}.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-end justify-between border-b-2 border-[#572020] pb-3 px-1">
                  <h2 className="font-serif text-xl sm:text-2xl text-[#572020]">
                    Demand Feed
                  </h2>
                  <div className="text-right">
                    <span className="block text-2xl font-serif text-[#8C1515] leading-none mb-0.5">
                      {data.totalUncovered.toLocaleString()}
                    </span>
                    <span className="text-[11px] uppercase tracking-wider text-[#8a6a5a] font-medium">
                      Unanswered{" "}
                      {data.distinctQuestions > 0 &&
                        `· ${data.distinctQuestions} distinct`}
                    </span>
                  </div>
                </div>

                <div className="rounded-2xl border border-[#E8DDD0] bg-gradient-to-b from-[#FBF8F4] to-[#F9F5EE] shadow-sm overflow-hidden">
                  {data.clusters.map((c) => (
                    <DemandFeedItemCluster
                      key={`cluster-${c.id}`}
                      c={c}
                      slug={data.pillar.slug}
                      windowDays={data.windowDays}
                      canPromote={canPromote}
                    />
                  ))}
                  {data.ungroupedUncovered.map((u, i) => (
                    <DemandFeedItemUngrouped
                      key={`ungrouped-${i}`}
                      u={u}
                      index={i}
                      slug={data.pillar.slug}
                      canPromote={canPromote}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </PortalShell>
  );
}

// ---------- Knowledge library ----------

interface SourceListItem {
  id: number;
  kind: "paper" | "slm_article" | "talk" | "note";
  title: string;
  authors: string | null;
  year: number | null;
  journal: string | null;
  doi: string | null;
  sourceUrl: string | null;
  studyDesign: string | null;
  rightsBasis:
    | "open_license"
    | "permission"
    | "public_domain"
    | "no_documented_full_text_rights"
    | null;
  retentionStatus:
    | "needs_review"
    | "review_window"
    | "retained_with_rights"
    | "purged_no_full_text_rights";
  rightsRecordedAt: string | null;
  purgedAt: string | null;
  status: "draft" | "in_review" | "approved" | "archived";
  version: number;
  assessmentStatus: "draft" | "approved" | null;
  rigorScore: number | null;
  reproducibilityScore: number | null;
  opennessScore: number | null;
  createdAt: string;
  updatedAt: string;
  automaticallyDiscovered: boolean;
  excluded: boolean;
  excludedAt?: string | null;
}

const STATUS_LABELS: Record<SourceListItem["status"], string> = {
  draft: "Draft",
  in_review: "In review",
  approved: "Approved",
  archived: "Archived",
};

const STATUS_COLORS: Record<SourceListItem["status"], string> = {
  draft: "#9a9a92",
  in_review: "#d4af37",
  approved: "#3a9a4f",
  archived: "#5a5a52",
};

function StatusBadge({ status }: { status: SourceListItem["status"] }) {
  return (
    <span
      className="text-[10px] tracking-[0.2em] uppercase border px-2 py-0.5 rounded"
      style={{
        color: STATUS_COLORS[status],
        borderColor: STATUS_COLORS[status],
      }}
      data-testid={`badge-status-${status}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

// Shared band palette for the three reliability axes — strong / moderate /
// limited / unknown. Used by both the library chip and the detail meters.
const RELIABILITY_BAND_COLORS: Record<
  ReturnType<typeof reliabilityBand>,
  { fg: string; bg: string; border: string }
> = {
  strong: { fg: "#2f7d41", bg: "#EAF3EC", border: "#CBE3D1" },
  moderate: { fg: "#8a6b14", bg: "#F6EFD9", border: "#E7D9AE" },
  limited: { fg: "#9a3325", bg: "#F6E6E2", border: "#E8CFC8" },
  unknown: { fg: "#8a6a5a", bg: "#F4ECDD", border: "#E8DDC8" },
};

const RELIABILITY_AXIS_SHORT: Record<ReliabilityAxisKey, string> = {
  rigor: "Rigor",
  reproducibility: "Repro",
  openness: "Open",
};

/**
 * Compact reliability chip for a library row. Shows the three approved axis
 * scores (public) as separate pills, a muted marker while a draft is pending
 * steward approval, and nothing at all when the source is unassessed.
 */
function ReliabilityListChip({ item }: { item: SourceListItem }) {
  if (item.assessmentStatus === "approved") {
    const axes: Array<{ key: ReliabilityAxisKey; score: number | null }> = [
      { key: "rigor", score: item.rigorScore },
      { key: "reproducibility", score: item.reproducibilityScore },
      { key: "openness", score: item.opennessScore },
    ];
    return (
      <span
        className="inline-flex flex-wrap items-center gap-1 mt-1.5 ml-1.5 align-middle"
        data-testid={`chip-reliability-${item.id}`}
        title="Steward-approved reliability (public). Three separate axes, never combined."
      >
        {axes.map((a) => {
          const c = RELIABILITY_BAND_COLORS[reliabilityBand(a.score)];
          return (
            <span
              key={a.key}
              className="text-[10px] rounded-full border px-1.5 py-0.5"
              style={{ color: c.fg, background: c.bg, borderColor: c.border }}
            >
              {RELIABILITY_AXIS_SHORT[a.key]}{" "}
              {a.score == null ? "n/a" : a.score}
            </span>
          );
        })}
      </span>
    );
  }
  if (item.assessmentStatus === "draft") {
    return (
      <span
        className="inline-block mt-1.5 ml-1.5 align-middle text-[10px] tracking-[0.04em] text-[#8a6b14] bg-[#F6EFD9] border border-[#E7D9AE] rounded-full px-2 py-0.5"
        data-testid={`chip-reliability-${item.id}`}
        title="AI reliability draft awaiting steward approval (not public)"
      >
        Reliability: draft
      </span>
    );
  }
  return null;
}

// Reusable team-invite affordance. Lives in the pillar library (Process 1's
// destination) so inviting colleagues and postdocs to assess and discuss papers
// is part of "bring your papers to life with your team", not a separate page.
// Steward/admin gated by the caller; returns null under admin view-as preview.
function InviteColleagueInline({
  slug,
  pillarId,
  pillarName,
}: {
  slug: string;
  pillarId: number;
  pillarName: string;
}) {
  const viewAs = useViewAs();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"contributor" | "advisor">("contributor");
  const [institution, setInstitution] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const inviteMutation = useMutation({
    mutationFn: (vars: {
      email: string;
      role: string;
      pillarId: number;
      institution?: string;
    }) =>
      fetchJson<{ email: string; role: string }>("/api/faculty/invitations", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: (r) => {
      setMsg(
        `Invitation sent to ${r.email} as ${r.role}. They'll draft; you approve.`,
      );
      setEmail("");
      setInstitution("");
    },
    onError: (e: Error) => setMsg(`Couldn't send: ${e.message}`),
  });

  // Admin view-as preview is strictly read-only — hide the write affordance.
  if (viewAs) return null;

  return (
    <section
      className="mb-8 rounded-xl border border-[#E8DDD0] bg-gradient-to-r from-[#F9F5EE] to-[#F4ECDD] p-5"
      data-testid="panel-invite-colleague"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#E8DDD0] bg-white text-[#8C1515]">
            <IconColleagues className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-[#572020]">
              Need another expert's eyes on this paper?
            </p>
            <p className="text-sm text-[#8a6a5a]">
              Invite colleagues and postdocs into {pillarName} to assess papers
              and draft answers. Every comment is attributed; nothing goes live
              until you approve it.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 rounded-lg border border-[#E8DDD0] bg-white px-4 py-2 text-sm font-medium text-[#8C1515] transition hover:border-[#8C1515]"
          data-testid="button-invite-toggle"
        >
          {open ? "Close" : "Invite a colleague"}
        </button>
      </div>

      {open && (
        <div className="mt-4 rounded-lg border border-[#E8DDD0] bg-white/70 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              type="email"
              placeholder="email@stanford.edu"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex-1 bg-white border border-[#E8DDD0] rounded-lg px-4 py-2 text-[#572020]"
              data-testid="input-team-invite-email"
            />
            <select
              value={role}
              onChange={(e) =>
                setRole(e.target.value as "contributor" | "advisor")
              }
              className="bg-white border border-[#E8DDD0] rounded-lg px-4 py-2 text-[#572020]"
              data-testid="select-team-invite-role"
            >
              <option value="contributor">Contributor</option>
              <option value="advisor">Advisor (cross-pillar lens)</option>
            </select>
            <button
              type="button"
              onClick={() =>
                email &&
                inviteMutation.mutate({
                  email,
                  role,
                  pillarId,
                  institution: institution.trim() || undefined,
                })
              }
              disabled={inviteMutation.isPending || !email}
              className="bg-[#8C1515] text-white px-5 py-2 rounded-lg font-medium hover:bg-[#a01a1a] disabled:opacity-50 transition whitespace-nowrap"
              data-testid="button-team-invite-send"
            >
              {inviteMutation.isPending ? "Sending…" : "Send invite"}
            </button>
          </div>
          <input
            type="text"
            placeholder="Their institution (optional) — e.g. Stanford Medicine"
            value={institution}
            onChange={(e) => setInstitution(e.target.value)}
            className="mt-3 w-full bg-white border border-[#E8DDD0] rounded-lg px-4 py-2 text-[#572020] text-sm"
            data-testid="input-team-invite-institution"
          />
          {msg && (
            <p
              className="text-sm text-[#8a6a5a] mt-3"
              data-testid="text-team-invite-msg"
            >
              {msg}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export function ExcludeSourceAction({ source, slug }: { source: SourceListItem; slug: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const qc = useQueryClient();
  const exclude = useMutation({
    mutationFn: async () => {
      await fetchJson(`/api/faculty/pillars/${slug}/sources/${source.id}/exclude`, {
        method: "POST",
        body: JSON.stringify({ reason: reason || undefined }),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["faculty-sources", slug] });
      void qc.invalidateQueries({ queryKey: ["faculty-coverage", slug] });
      setReason("");
      setOpen(false);
    },
  });

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-xs text-[#8C1515] hover:underline whitespace-nowrap ml-3"
        data-testid={`button-exclude-${source.id}`}
        title="Exclude from this pillar"
      >
        Exclude
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 bg-white border border-[#E8DDD0] rounded-lg shadow-lg p-4 z-10 text-left font-sans cursor-default">
          <h4 className="font-medium text-[#572020] mb-2 text-sm">Exclude from pillar</h4>
          <p className="text-xs text-[#8a6a5a] mb-3 leading-relaxed">
            This removes the work from the active system. Automatic discovery will not add this same record again.
          </p>
          <input
            type="text"
            placeholder="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            className="w-full text-sm border border-[#E8DDD0] rounded px-2 py-1.5 mb-3 text-[#572020] placeholder:text-[#8a6a5a]"
            data-testid={`input-exclude-reason-${source.id}`}
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-3 py-1.5 text-xs text-[#8a6a5a] hover:bg-gray-100 rounded border border-transparent"
              disabled={exclude.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => exclude.mutate()}
              className="px-3 py-1.5 text-xs bg-[#8C1515] text-white rounded hover:bg-[#a01a1a]"
              disabled={exclude.isPending}
              data-testid={`button-confirm-exclude-${source.id}`}
            >
              {exclude.isPending ? "Excluding..." : "Confirm Exclude"}
            </button>
          </div>
          {exclude.isError && (
            <p className="mt-2 text-xs text-[#8C1515]" role="alert">
              {(exclude.error as Error).message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function PillarLibrary() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const qc = useQueryClient();
  const viewAs = useViewAs();
  const { data: me } = useMe();
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [assessFilter, setAssessFilter] = useState<
    "all" | "approved" | "draft" | "none"
  >("all");
  const [sortBy, setSortBy] = useState<
    "recent" | "rigor" | "reproducibility" | "openness"
  >("recent");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [batchActive, setBatchActive] = useState(false);
  const [batchMsg, setBatchMsg] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState({
    kind: "paper" as "paper" | "slm_article" | "talk" | "note",
    title: "",
    authors: "",
    year: "",
    journal: "",
    doi: "",
    sourceUrl: "",
    studyDesign: "",
    rightsBasis: "",
    abstract: "",
    text: "",
  });
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);

  const { data: pillar } = useQuery<{
    id: number;
    slug: string;
    name: string;
    role: string | null;
  }>({
    queryKey: ["faculty-pillar", slug],
    queryFn: () => fetchJson(`/api/faculty/pillars/${slug}`),
  });

  const { data, isLoading, error, isFetching, isSuccess } = useQuery<{
    sources: SourceListItem[];
  }>({
    queryKey: ["faculty-sources", slug, statusFilter],
    queryFn: () =>
      fetchJson(
        `/api/faculty/pillars/${slug}/sources${statusFilter ? `?status=${statusFilter}` : ""}`,
      ),
    // While a batch drafting run is in flight, poll so the new drafts show up
    // in the queue as the background worker finishes each source.
    refetchInterval: batchActive ? 4000 : false,
  });

  // Client-side reliability filter + sort over the already-fetched list.
  const visibleSources = useMemo(() => {
    let list = data?.sources ?? [];
    if (assessFilter === "approved") {
      list = list.filter((s) => s.assessmentStatus === "approved");
    } else if (assessFilter === "draft") {
      list = list.filter((s) => s.assessmentStatus === "draft");
    } else if (assessFilter === "none") {
      list = list.filter((s) => !s.assessmentStatus);
    }
    if (sortBy !== "recent") {
      const key =
        sortBy === "rigor"
          ? "rigorScore"
          : sortBy === "reproducibility"
            ? "reproducibilityScore"
            : "opennessScore";
      // Approved scores first (highest), unassessed/null last.
      list = [...list].sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1));
    }
    return list;
  }, [data, assessFilter, sortBy]);

  const upload = useMutation({
    mutationFn: async () => {
      // Admin view-as preview is strictly read-only. This upload uses raw
      // fetch (multipart), so it does NOT pass through fetchJson's mutation
      // guard — block it explicitly so a preview can never write a source.
      if (viewAs) {
        throw new Error(
          "Read-only preview — exit preview to make changes as yourself.",
        );
      }
      const fd = new FormData();
      for (const [k, v] of Object.entries(meta)) {
        if (v) fd.append(k, v);
      }
      if (file) fd.append("file", file);
      const res = await fetch(`/api/faculty/pillars/${slug}/sources`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `${res.status}`);
      }
      return res.json() as Promise<{
        id: number;
        title: string;
        chunkCount: number;
        embeddedCount?: number;
        charCount?: number;
        versioned: boolean;
        firstDraftId: number | null;
      }>;
    },
    onSuccess: (r) => {
      const embedded = r.embeddedCount ?? r.chunkCount;
      const chars =
        typeof r.charCount === "number"
          ? `${r.charCount.toLocaleString()} characters extracted, `
          : "";
      setUploadMsg(
        r.versioned
          ? `Updated "${r.title}" — ${chars}${r.chunkCount} passages created, ${embedded}/${r.chunkCount} embedded and searchable. Once approved, the agent can cite the new version.`
          : `Ingested "${r.title}" — The system created a private first draft for steward review. ${chars}${r.chunkCount} passages are available only during the review window.`,
      );
      setFile(null);
      setMeta({
        kind: "paper",
        title: "",
        authors: "",
        year: "",
        journal: "",
        doi: "",
        sourceUrl: "",
        studyDesign: "",
        rightsBasis: "",
        abstract: "",
        text: "",
      });
      qc.invalidateQueries({ queryKey: ["faculty-sources", slug] });
    },
    onError: (e: Error) => setUploadMsg(`Error: ${e.message}`),
  });

  // Hide every write affordance while previewing as another member (the role
  // here is the previewed member's, not the admin's). Preview is read-only.
  const canUpload =
    !viewAs &&
    (!!me?.user.isPlatformAdmin ||
      pillar?.role === "steward" ||
      pillar?.role === "contributor");
  const isSteward = !!me?.user.isPlatformAdmin || pillar?.role === "steward";

  // Approved sources in this pillar that still have no reliability assessment —
  // the batch-draft candidates. Counted from the loaded list as a hint; the
  // server recomputes the authoritative set when the batch runs.
  const unassessedApprovedCount = useMemo(
    () =>
      (data?.sources ?? []).filter(
        (s) => s.status === "approved" && !s.assessmentStatus,
      ).length,
    [data],
  );

  const batchDraft = useMutation({
    mutationFn: () =>
      fetchJson<{ candidates: number; queued: number; generated: boolean }>(
        `/api/faculty/pillars/${slug}/sources/assessments/batch-draft`,
        { method: "POST" },
      ),
    onSuccess: (r) => {
      if (r.candidates === 0) {
        setBatchActive(false);
        setBatchMsg(
          "Every approved paper already has a reliability assessment.",
        );
        return;
      }
      if (!r.generated) {
        setBatchActive(false);
        setBatchMsg(
          "The AI scorer is unavailable right now. Try again later, or assess papers one at a time.",
        );
        return;
      }
      // Surface the draft queue and poll while the background worker fills it.
      setStatusFilter("");
      setAssessFilter("draft");
      setBatchActive(true);
      setBatchMsg(
        `Drafting reliability assessments for ${r.queued} approved ${
          r.queued === 1 ? "paper" : "papers"
        } in the background. Each draft appears below as it finishes — review and approve to publish.`,
      );
      qc.invalidateQueries({ queryKey: ["faculty-sources", slug] });
      // Safety stop: never poll forever if some sources fail to draft.
      window.setTimeout(() => setBatchActive(false), 180_000);
    },
    onError: (e: Error) => {
      setBatchActive(false);
      setBatchMsg(`Error: ${e.message}`);
    },
  });

  // Stop polling once every approved paper has at least a draft — but ONLY off
  // a fresh, settled fetch. After a batch run we flip statusFilter to "" (a new
  // query key), so `data` is briefly undefined and the count is transiently 0;
  // gating on a completed, non-fetching load with real data avoids a premature
  // "all drafted" banner while the background worker is still running.
  useEffect(() => {
    if (
      batchActive &&
      isSuccess &&
      !isFetching &&
      data !== undefined &&
      unassessedApprovedCount === 0
    ) {
      setBatchActive(false);
      setBatchMsg(
        "All approved papers now have a draft assessment. Review each one and approve to publish.",
      );
    }
  }, [batchActive, isSuccess, isFetching, data, unassessedApprovedCount]);

  // Pre-filled draft from a coverage-gap cluster: surfaces a banner that
  // explains why the steward landed here and points them at "Add source".
  const draftQuestion = (() => {
    try {
      return new URLSearchParams(window.location.search).get("draft") ?? null;
    } catch {
      return null;
    }
  })();

  return (
    <PortalShell>
      <Link
        href={`/pillars/${slug}`}
        className="text-sm text-[#8a6a5a] hover:text-[#572020]"
      >
        ← {pillar?.name ?? slug}
      </Link>
      {draftQuestion && (
        <section
          className="mt-4 border border-[#E8352A]/40 bg-[#FCEDEB] rounded-xl p-5"
          data-testid="draft-banner"
        >
          <p className="text-[10px] tracking-[0.25em] uppercase text-[#E8352A] mb-2">
            Drafting an interpretation
          </p>
          <p className="text-[#572020] font-serif text-lg leading-snug mb-2">
            "{draftQuestion}"
          </p>
          <p className="text-sm text-[#8a6a5a]">
            Pick the source below that best answers this — then add an
            interpretation. If no source covers it yet, click{" "}
            <strong>Add source</strong> above to upload one.
          </p>
        </section>
      )}
      <div className="flex items-baseline justify-between mt-4 mb-8">
        <div>
          <p className="text-[10px] tracking-[0.25em] text-[#8C1515] uppercase mb-2">
            Knowledge library
          </p>
          <h1 className="font-serif text-3xl font-medium">
            {pillar?.name ?? "Library"}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/pillars/${slug}/knowledge`}
            className="border border-[#E8DDD0] text-[#572020] px-4 py-2 rounded-lg text-sm font-medium hover:border-[#8C1515]"
            data-testid="link-governed-knowledge"
          >
            Claim map
          </Link>
          {isSteward && !viewAs && (
            <button
              onClick={() => batchDraft.mutate()}
              disabled={batchDraft.isPending || batchActive}
              className="border border-[#E8DDD0] text-[#572020] px-4 py-2 rounded-lg text-sm font-medium hover:border-[#8C1515] disabled:opacity-50"
              data-testid="button-batch-draft"
              title="Draft AI reliability assessments for every approved paper that has none yet. Each lands as a draft for you to review and approve."
            >
              {batchDraft.isPending || batchActive
                ? "Drafting…"
                : unassessedApprovedCount > 0
                  ? `Draft all reliability (${unassessedApprovedCount})`
                  : "Draft all reliability"}
            </button>
          )}
          {canUpload && (
            <button
              onClick={() => setUploadOpen((v) => !v)}
              className="bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a]"
              data-testid="button-toggle-upload"
            >
              {uploadOpen ? "Close" : "Add source"}
            </button>
          )}
        </div>
      </div>

      {isSteward && pillar && (
        <InviteColleagueInline
          slug={slug}
          pillarId={pillar.id}
          pillarName={pillar.name}
        />
      )}

      {isSteward && batchMsg && (
        <section
          className="mb-6 border border-[#E8DDD0] bg-[#F9F5EE] rounded-xl p-4 flex items-start justify-between gap-3"
          data-testid="batch-draft-banner"
        >
          <p className="text-sm text-[#572020] leading-relaxed">{batchMsg}</p>
          <button
            onClick={() => setBatchMsg(null)}
            className="shrink-0 text-xs text-[#8a6a5a] hover:text-[#572020]"
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </section>
      )}

      {uploadOpen && canUpload && (
        <section className="border border-[#E8DDD0] rounded-xl p-6 mb-8">
          <h2 className="font-serif text-lg mb-4">Add a source</h2>
          {me?.user.isPlatformAdmin && (
            <p
              className="mb-4 border-l-4 border-[#8C1515] bg-[#FBF7F0] px-4 py-3 text-sm leading-relaxed text-[#572020]"
              data-testid="admin-proxy-upload-note"
            >
              Admin proxy mode. Uploads are attributed to your account and enter
              this pillar&apos;s existing steward review workflow. They are
              indexed for review but do not become available to the public
              answer system until approved.
            </p>
          )}
          <div className="grid gap-3 max-w-2xl">
            <select
              value={meta.kind}
              onChange={(e) =>
                setMeta({ ...meta, kind: e.target.value as typeof meta.kind })
              }
              className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2"
              data-testid="select-kind"
            >
              <option value="paper">Paper</option>
              <option value="slm_article">
                Stanford Lifestyle Medicine article
              </option>
              <option value="talk">Talk or transcript</option>
              <option value="note">Note</option>
            </select>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                if (!f) {
                  setFile(null);
                  return;
                }
                // Client-side pre-checks mirroring the server's limits so the
                // uploader gets instant feedback instead of a failed request.
                const isPdf =
                  f.type === "application/pdf" ||
                  f.name.toLowerCase().endsWith(".pdf");
                if (!isPdf) {
                  setFile(null);
                  e.target.value = "";
                  setUploadMsg(
                    "Error: Only PDF files are supported. To add other material, paste the text into the field below instead.",
                  );
                  return;
                }
                if (f.size > 25 * 1024 * 1024) {
                  setFile(null);
                  e.target.value = "";
                  setUploadMsg(
                    `Error: "${f.name}" is ${(f.size / (1024 * 1024)).toFixed(1)} MB — the limit is 25 MB. Try a compressed or text-only version of the PDF.`,
                  );
                  return;
                }
                setUploadMsg(null);
                setFile(f);
              }}
              className="text-sm text-[#8a6a5a]"
              data-testid="input-file"
            />
            <p
              className="text-xs text-[#8a6a5a] leading-relaxed -mt-1"
              data-testid="text-upload-guidance"
            >
              PDF only, up to 25 MB. Text-based PDFs work best — scanned
              image-only PDFs can't be read. No PDF? Paste the full text into
              the "Full text" field below instead (also for very large documents
              — pasted text has no 25 MB file cap). After upload, the document
              is split into passages and embedded so the agent can cite an
              approved original interpretation. The PDF itself is processed from
              memory and is never stored as a file.
            </p>
            <input
              placeholder="Title (optional if PDF)"
              value={meta.title}
              onChange={(e) => setMeta({ ...meta, title: e.target.value })}
              className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2"
              data-testid="input-title"
            />
            <label className="flex flex-col gap-1 text-xs text-[#8a6a5a]">
              Why may the system process this source's full text?{" "}
              <span className="text-[#8C1515]">Required</span>
              <select
                value={meta.rightsBasis}
                onChange={(e) =>
                  setMeta({ ...meta, rightsBasis: e.target.value })
                }
                className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm text-[#572020]"
                data-testid="select-rights-basis"
              >
                <option value="">— Select a documented basis —</option>
                <option value="open_license">Open licence</option>
                <option value="permission">
                  Permission to process the full text
                </option>
                <option value="public_domain">Public domain</option>
                <option value="no_documented_full_text_rights">
                  No documented full-text rights — temporary review only
                </option>
              </select>
              <span className="leading-relaxed">
                For the last option, passages are available only to faculty
                while reviewing. Once the source is approved or archived,
                The system deletes source text, chunks, embeddings, and snapshots,
                while keeping citation data and any steward-approved original
                interpretation.
              </span>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <input
                placeholder="Authors"
                value={meta.authors}
                onChange={(e) => setMeta({ ...meta, authors: e.target.value })}
                className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2"
              />
              <input
                placeholder="Year"
                value={meta.year}
                onChange={(e) => setMeta({ ...meta, year: e.target.value })}
                className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input
                placeholder="Journal"
                value={meta.journal}
                onChange={(e) => setMeta({ ...meta, journal: e.target.value })}
                className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2"
              />
              <input
                placeholder="DOI"
                value={meta.doi}
                onChange={(e) => setMeta({ ...meta, doi: e.target.value })}
                className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2"
                data-testid="input-doi"
              />
            </div>
            <input
              placeholder="Source URL"
              value={meta.sourceUrl}
              onChange={(e) => setMeta({ ...meta, sourceUrl: e.target.value })}
              className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2"
            />
            <label className="flex flex-col gap-1 text-xs text-[#8a6a5a]">
              Study type (optional)
              <select
                value={meta.studyDesign}
                onChange={(e) =>
                  setMeta({ ...meta, studyDesign: e.target.value })
                }
                className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm text-[#572020]"
                data-testid="select-study-design"
              >
                <option value="">— Not specified —</option>
                {STUDY_DESIGNS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <textarea
              placeholder="Abstract (used as fallback text if no PDF)"
              value={meta.abstract}
              onChange={(e) => setMeta({ ...meta, abstract: e.target.value })}
              rows={3}
              className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2"
            />
            <textarea
              placeholder="Or paste full text directly"
              value={meta.text}
              onChange={(e) => setMeta({ ...meta, text: e.target.value })}
              rows={4}
              className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2"
              data-testid="input-text"
            />
            <button
              onClick={() => upload.mutate()}
              disabled={
                upload.isPending ||
                (!file && !meta.text && !meta.abstract) ||
                !meta.rightsBasis
              }
              className="bg-[#8C1515] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#a01a1a] disabled:opacity-50 w-fit"
              data-testid="button-ingest"
            >
              {upload.isPending ? "Ingesting…" : "Ingest source"}
            </button>
            {uploadMsg && (
              <p
                className="text-sm text-[#8a6a5a]"
                data-testid="text-upload-msg"
              >
                {uploadMsg}
              </p>
            )}
          </div>
        </section>
      )}

      <div className="flex items-center gap-3 mb-4 text-sm">
        <span className="text-[#8a6a5a]">Filter:</span>
        {(["", "draft", "in_review", "approved", "archived"] as const).map(
          (s) => (
            <button
              key={s || "all"}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1 rounded border ${
                statusFilter === s
                  ? "border-[#8C1515] text-[#572020]"
                  : "border-[#E8DDD0] text-[#8a6a5a] hover:border-[#E8DDD0]"
              }`}
              data-testid={`filter-${s || "all"}`}
            >
              {s === "" ? "All" : STATUS_LABELS[s as SourceListItem["status"]]}
            </button>
          ),
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-4 text-sm">
        <span className="text-[#8a6a5a]">Reliability:</span>
        {(
          [
            ["all", "All"],
            ["approved", "Approved (public)"],
            ["draft", "Drafts"],
            ["none", "Unassessed"],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setAssessFilter(v)}
            className={`px-3 py-1 rounded border ${
              assessFilter === v
                ? "border-[#8C1515] text-[#572020]"
                : "border-[#E8DDD0] text-[#8a6a5a] hover:border-[#E8DDD0]"
            }`}
            data-testid={`filter-assess-${v}`}
          >
            {label}
          </button>
        ))}
        <span className="text-[#8a6a5a] ml-auto">Sort:</span>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          className="px-2 py-1 rounded border border-[#E8DDD0] text-[#572020] bg-white"
          data-testid="sort-reliability"
        >
          <option value="recent">Most recent</option>
          <option value="rigor">Rigor score</option>
          <option value="reproducibility">Reproducibility score</option>
          <option value="openness">Openness score</option>
        </select>
      </div>

      {isLoading && <p className="text-[#8a6a5a]">Loading…</p>}
      {error && <p className="text-[#E8352A]">{(error as Error).message}</p>}
      {data && data.sources.length === 0 && (
        <p className="text-[#8a6a5a] italic">
          No sources yet. {canUpload ? "Add the first one above." : ""}
        </p>
      )}
      {data && data.sources.length > 0 && visibleSources.length === 0 && (
        <p className="text-[#8a6a5a] italic">
          No sources match this reliability filter.
        </p>
      )}
      <div className="divide-y divide-[#E8DDD0] border-y border-[#E8DDD0]">
        {visibleSources.map((s) => (
          <div
            key={s.id}
            className="flex items-center justify-between py-4 hover:bg-[#F4ECDD] px-2 -mx-2 rounded relative group"
            data-testid={`row-source-${s.id}`}
          >
            <Link
              href={`/pillars/${slug}/sources/${s.id}`}
              className="flex-1 min-w-0 mr-4 no-underline block"
            >
              <div className="min-w-0 mr-4">
                <p className="font-serif text-base text-[#572020] truncate">
                  {s.title}
                </p>
                <div className="text-xs text-[#8a6a5a] mt-1 truncate flex items-center gap-2">
                  <span className="truncate">
                    {[s.authors, s.journal, s.year].filter(Boolean).join(" · ")}
                    {s.version > 1 && ` · v${s.version}`}
                  </span>
                  {s.automaticallyDiscovered && (
                    <span
                      className="inline-block px-1.5 py-0.5 rounded-sm bg-[#F9F5EE] border border-[#E8DDD0] text-[#8C1515] text-[9px] uppercase tracking-[0.1em] font-bold whitespace-nowrap shrink-0"
                      data-testid={`badge-discovered-${s.id}`}
                    >
                      Discovered
                    </span>
                  )}
                </div>
                <div>
                  {studyDesignLabel(s.studyDesign) && (
                    <span className="inline-block mt-1.5 text-[10px] tracking-[0.04em] text-[#6b5a3a] bg-[#F4ECDD] border border-[#E8DDC8] rounded-full px-2 py-0.5">
                      {studyDesignLabel(s.studyDesign)}
                    </span>
                  )}
                  <ReliabilityListChip item={s} />
                </div>
              </div>
            </Link>
            <div className="flex items-center shrink-0">
              <StatusBadge status={s.status} />

              {s.automaticallyDiscovered && isSteward && !viewAs && (
                <ExcludeSourceAction source={s} slug={slug!} />
              )}
            </div>
          </div>
        ))}
      </div>
    </PortalShell>
  );
}

interface SourceDetail {
  source: {
    id: number;
    kind: "paper" | "slm_article" | "talk" | "note";
    title: string;
    authors: string | null;
    year: number | null;
    journal: string | null;
    doi: string | null;
    abstract: string | null;
    fullText: string | null;
    sourceUrl: string | null;
    studyDesign: string | null;
    rightsBasis: SourceListItem["rightsBasis"];
    retentionStatus: SourceListItem["retentionStatus"];
    rightsRecordedAt: string | null;
    purgedAt: string | null;
    status: SourceListItem["status"];
    version: number;
    createdAt: string;
    updatedAt: string;
  };
  chunkCount: number;
  reviewPassagesAvailable: boolean;
  chunks: Array<{
    id: number;
    chunkIndex: number;
    text: string;
    page: number | null;
    section: string | null;
  }>;
  audit: Array<{
    id: number;
    action: string;
    fromStatus: string | null;
    toStatus: string | null;
    note: string | null;
    createdAt: string;
  }>;
  role: "steward" | "contributor" | "advisor" | "viewer" | null;
}

// ---------- Source workflow guidance ----------

// Plain-language guidance for each stage of a paper's life. Shown in the
// orientation card at the top of the source page so a steward and their team
// always know where a paper stands and what to do next — replacing the bare
// row of "Draft / In review / Archived" buttons that used to sit right under
// the title with no explanation.
const SOURCE_STAGE_GUIDE: Record<
  SourceListItem["status"],
  { headline: string; meaning: string; next: string }
> = {
  draft: {
    headline: "Draft — visible only to your team",
    meaning:
      "You're still preparing this paper. Nobody outside your pillar team can see it, and The AI won't use it in any answer yet.",
    next: "When it's ready for the team to read and interpret together, move it to In review.",
  },
  in_review: {
    headline: "In review — your team is working on it",
    meaning:
      "The paper is in front of your team to read, discuss, and turn into an interpretation. It's still private — readers and the AI can't see it.",
    next: "Approve an interpretation below, then mark the paper Approved so those answers can reach readers.",
  },
  approved: {
    headline: "Approved — part of your pillar's knowledge",
    meaning:
      "This paper is live in your pillar. Its approved interpretations can be cited by The AI when it answers readers.",
    next: "Keep its interpretations current. Archive the paper if a newer study supersedes it.",
  },
  archived: {
    headline: "Archived — retired from answers",
    meaning:
      "This paper is kept for the record but is no longer used in any answer to readers.",
    next: "Move it back to Draft if you want to bring it into the workflow again.",
  },
};

// The single natural "forward" step from the current stage — styled as the
// primary action so the obvious next move stands out and quieter moves (like
// Archive) stay secondary.
const SOURCE_FORWARD_STEP: Partial<
  Record<SourceListItem["status"], SourceListItem["status"]>
> = {
  draft: "in_review",
  in_review: "approved",
};

const SOURCE_TRANSITION_HINT: Record<SourceListItem["status"], string> = {
  draft: "Send it back to a private draft only your team can see.",
  in_review: "Open it up for your team to read, discuss, and interpret.",
  approved:
    "Make its approved interpretations citable by The AI in answers to readers.",
  archived: "Retire it — keep the record but stop using it in answers.",
};

/**
 * Orientation card at the top of the source page. Leads with a read-only
 * stepper + plain-language explanation of where the paper stands and what to
 * do next, then offers the status-change controls below — framed and explained
 * rather than a bare button row.
 */
function SourceWorkflowCard({
  status,
  allowed,
  onTransition,
  pending,
  error,
}: {
  status: SourceListItem["status"];
  allowed: SourceListItem["status"][];
  onTransition: (s: SourceListItem["status"]) => void;
  pending: boolean;
  error: string | null;
}) {
  const STAGES: SourceListItem["status"][] = ["draft", "in_review", "approved"];
  const guide = SOURCE_STAGE_GUIDE[status];
  const archived = status === "archived";
  const currentIdx = STAGES.indexOf(status);
  const forward = SOURCE_FORWARD_STEP[status];
  const forwardAllowed = forward && allowed.includes(forward) ? forward : null;
  const others = allowed.filter((s) => s !== forwardAllowed);

  return (
    <section
      className="rounded-2xl border border-[#E8DDD0] bg-gradient-to-br from-[#F9F5EE] to-[#F4ECDD] p-6 sm:p-7 mb-10"
      data-testid="source-workflow"
    >
      {/* Read-only stepper — where this paper sits in its life, at a glance. */}
      <ol className="flex flex-wrap items-center gap-y-2 mb-6">
        {STAGES.map((st, i) => {
          const done = !archived && i < currentIdx;
          const active = !archived && i === currentIdx;
          const color = active ? "#8C1515" : done ? "#3a9a4f" : "#cdbfae";
          return (
            <li key={st} className="flex items-center">
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold"
                style={{
                  borderColor: color,
                  color: active ? "#fff" : color,
                  background: active ? "#8C1515" : "transparent",
                }}
              >
                {done ? "✓" : i + 1}
              </span>
              <span
                className="ml-2 text-xs sm:text-sm whitespace-nowrap"
                style={{
                  color: active ? "#572020" : "#8a6a5a",
                  fontWeight: active ? 600 : 400,
                }}
              >
                {STATUS_LABELS[st]}
              </span>
              {i < STAGES.length - 1 && (
                <span
                  className="mx-2 sm:mx-3 h-px w-6 sm:w-10"
                  style={{ background: done ? "#3a9a4f" : "#E0D3C0" }}
                />
              )}
            </li>
          );
        })}
        {archived && (
          <li className="ml-3">
            <StatusBadge status="archived" />
          </li>
        )}
      </ol>

      <h2 className="font-serif text-xl text-[#572020] mb-1.5">
        {guide.headline}
      </h2>
      <p className="text-sm text-[#8a6a5a] leading-relaxed max-w-2xl">
        {guide.meaning}
      </p>
      <p className="mt-2 text-sm text-[#572020] leading-relaxed max-w-2xl">
        <span className="font-medium text-[#8C1515]">What's next: </span>
        {guide.next}
      </p>

      {allowed.length > 0 && (
        <div className="mt-6 pt-5 border-t border-[#E8DDD0]">
          <p className="text-[10px] tracking-[0.2em] uppercase text-[#8a6a5a] mb-3">
            Move this paper
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {forwardAllowed && (
              <button
                onClick={() => onTransition(forwardAllowed)}
                disabled={pending}
                className="rounded-lg bg-[#8C1515] px-4 py-2 text-sm font-medium text-white hover:bg-[#a01a1a] disabled:opacity-50"
                data-testid={`button-transition-${forwardAllowed}`}
                title={SOURCE_TRANSITION_HINT[forwardAllowed]}
              >
                {pending
                  ? "Saving…"
                  : `Move to ${STATUS_LABELS[forwardAllowed]} →`}
              </button>
            )}
            {others.map((s2) => (
              <button
                key={s2}
                onClick={() => onTransition(s2)}
                disabled={pending}
                className="rounded-lg border border-[#E8DDD0] bg-white px-3.5 py-2 text-sm text-[#572020] hover:border-[#8C1515] disabled:opacity-50"
                data-testid={`button-transition-${s2}`}
                title={SOURCE_TRANSITION_HINT[s2]}
              >
                {s2 === "archived"
                  ? "Archive"
                  : s2 === "draft"
                    ? "Back to draft"
                    : STATUS_LABELS[s2]}
              </button>
            ))}
          </div>
          {forwardAllowed && (
            <p className="mt-2 text-xs text-[#8a6a5a]">
              {SOURCE_TRANSITION_HINT[forwardAllowed]}
            </p>
          )}
          {error && (
            <p
              className="mt-2 text-xs text-[#E8352A]"
              data-testid="text-transition-error"
            >
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function SourceDetailPage() {
  const params = useParams<{ slug: string; id: string }>();
  const { slug, id } = params;
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery<SourceDetail>({
    queryKey: ["faculty-source", slug, id],
    queryFn: () => fetchJson(`/api/faculty/pillars/${slug}/sources/${id}`),
  });

  const transition = useMutation({
    mutationFn: (status: SourceListItem["status"]) =>
      fetchJson(`/api/faculty/pillars/${slug}/sources/${id}/transition`, {
        method: "POST",
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["faculty-source", slug, id] });
      qc.invalidateQueries({ queryKey: ["faculty-sources", slug] });
    },
  });

  const updateStudyDesign = useMutation({
    mutationFn: (studyDesign: string | null) =>
      fetchJson(`/api/faculty/pillars/${slug}/sources/${id}/study-design`, {
        method: "PATCH",
        body: JSON.stringify({ studyDesign }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["faculty-source", slug, id] });
      qc.invalidateQueries({ queryKey: ["faculty-sources", slug] });
    },
  });

  const updateRights = useMutation({
    mutationFn: (rightsBasis: NonNullable<SourceListItem["rightsBasis"]>) =>
      fetchJson(`/api/faculty/pillars/${slug}/sources/${id}/rights`, {
        method: "PATCH",
        body: JSON.stringify({ rightsBasis }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["faculty-source", slug, id] });
      qc.invalidateQueries({ queryKey: ["faculty-sources", slug] });
    },
  });

  if (isLoading)
    return (
      <PortalShell>
        <p className="text-[#8a6a5a]">Loading…</p>
      </PortalShell>
    );
  if (error)
    return (
      <PortalShell>
        <p className="text-[#E8352A]">{(error as Error).message}</p>
      </PortalShell>
    );
  if (!data) return null;

  const s = data.source;
  const role = data.role;
  const allowed: SourceListItem["status"][] =
    role === "steward"
      ? (["draft", "in_review", "approved", "archived"] as const).filter(
          (x) => x !== s.status,
        )
      : role === "contributor" || role === "advisor"
        ? s.status === "draft"
          ? ["in_review"]
          : s.status === "in_review"
            ? ["draft"]
            : []
        : [];

  return (
    <PortalShell>
      <Link
        href={`/pillars/${slug}/library`}
        className="text-sm text-[#8a6a5a] hover:text-[#572020]"
      >
        ← Library
      </Link>
      <div className="mt-4 mb-8">
        <div className="min-w-0">
          <div className="flex items-center gap-3 mb-2">
            <p className="text-[10px] tracking-[0.25em] text-[#8C1515] uppercase">
              {s.kind === "slm_article" ? "SLM article" : s.kind}
              {s.version > 1 && ` · v${s.version}`}
            </p>
            <StatusBadge status={s.status} />
          </div>
          <h1
            className="font-serif text-3xl font-medium leading-tight"
            data-testid="text-source-title"
          >
            {s.title}
          </h1>
          <p className="text-sm text-[#8a6a5a] mt-2">
            {[s.authors, s.journal, s.year].filter(Boolean).join(" · ")}
          </p>
          {s.doi && <p className="text-xs text-[#8a6a5a] mt-1">DOI: {s.doi}</p>}
          {s.sourceUrl && (
            <a
              href={s.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-[#8C1515] hover:underline"
            >
              {s.sourceUrl}
            </a>
          )}
          <div className="mt-3 flex items-center gap-3">
            <span className="text-[10px] tracking-[0.2em] text-[#8a6a5a] uppercase">
              Study type
            </span>
            {role === "steward" ? (
              <>
                <select
                  value={s.studyDesign ?? ""}
                  onChange={(e) =>
                    updateStudyDesign.mutate(e.target.value || null)
                  }
                  disabled={updateStudyDesign.isPending}
                  className="bg-white border border-[#E8DDD0] rounded-lg px-2 py-1 text-sm text-[#572020] disabled:opacity-50"
                  data-testid="select-edit-study-design"
                >
                  <option value="">— Not specified —</option>
                  {STUDY_DESIGNS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
                {updateStudyDesign.isPending && (
                  <span className="text-xs text-[#8a6a5a]">Saving…</span>
                )}
              </>
            ) : (
              <span
                className="text-sm text-[#572020]"
                data-testid="text-study-design"
              >
                {studyDesignLabel(s.studyDesign) ?? "—"}
              </span>
            )}
          </div>
          {updateStudyDesign.error && (
            <p className="text-xs text-[#E8352A] mt-1">
              {(updateStudyDesign.error as Error).message}
            </p>
          )}
          <section
            className="mt-5 rounded-xl border border-[#E8DDD0] bg-[#FBF7F0] p-4"
            data-testid="source-rights-status"
          >
            <p className="text-[10px] tracking-[0.18em] uppercase text-[#8a6a5a]">
              Full-text rights & retention
            </p>
            <p className="mt-1 text-sm text-[#572020]">
              {s.rightsBasis === "open_license"
                ? "Open licence — full text may be retained."
                : s.rightsBasis === "permission"
                  ? "Permission recorded — full text may be retained."
                  : s.rightsBasis === "public_domain"
                    ? "Public domain — full text may be retained."
                    : s.rightsBasis === "no_documented_full_text_rights"
                      ? s.retentionStatus === "purged_no_full_text_rights"
                        ? "No documented full-text rights — paper material has been purged."
                        : "No documented full-text rights — temporary faculty review window."
                      : "Not yet recorded — review this historical source before approving it."}
            </p>
            {s.retentionStatus === "purged_no_full_text_rights" ? (
              <p className="mt-1 text-xs text-[#8a6a5a]">
                The citation and steward-approved original interpretation
                remain. Paper text, passages, embeddings, and text snapshots do
                not.
              </p>
            ) : (
              <p className="mt-1 text-xs text-[#8a6a5a]">
                {data.reviewPassagesAvailable
                  ? "Supporting passages are faculty-only during the review window."
                  : "Supporting passages are not available."}
              </p>
            )}
            {role === "steward" &&
              s.retentionStatus !== "purged_no_full_text_rights" && (
                <label className="mt-3 flex max-w-md flex-col gap-1 text-xs text-[#8a6a5a]">
                  Record or correct rights basis
                  <select
                    value={s.rightsBasis ?? ""}
                    onChange={(e) => {
                      if (e.target.value) {
                        updateRights.mutate(
                          e.target.value as NonNullable<
                            SourceListItem["rightsBasis"]
                          >,
                        );
                      }
                    }}
                    disabled={updateRights.isPending}
                    className="bg-white border border-[#E8DDD0] rounded-lg px-2 py-1.5 text-sm text-[#572020]"
                    data-testid="select-edit-rights-basis"
                  >
                    <option value="">— Not recorded —</option>
                    <option value="open_license">Open licence</option>
                    <option value="permission">
                      Permission to process full text
                    </option>
                    <option value="public_domain">Public domain</option>
                    <option value="no_documented_full_text_rights">
                      No documented full-text rights
                    </option>
                  </select>
                </label>
              )}
            {updateRights.error && (
              <p className="mt-2 text-xs text-[#E8352A]">
                {(updateRights.error as Error).message}
              </p>
            )}
          </section>
        </div>
      </div>

      <SourceWorkflowCard
        status={s.status}
        allowed={allowed}
        onTransition={(st) => transition.mutate(st)}
        pending={transition.isPending}
        error={transition.error ? (transition.error as Error).message : null}
      />

      {(s.abstract || s.fullText) && (
        <section className="mb-10">
          <h2 className="font-serif text-2xl text-[#572020] mb-3">The paper</h2>
          {s.abstract && (
            <>
              <p className="text-[10px] tracking-[0.2em] uppercase text-[#8a6a5a] mb-1">
                Abstract
              </p>
              <p className="text-sm text-[#572020] leading-relaxed whitespace-pre-wrap mb-4">
                {s.abstract}
              </p>
            </>
          )}
          {s.fullText && (
            <details className="group rounded-xl border border-[#E8DDD0] bg-[#FFFDF8] p-4">
              <summary className="text-sm font-medium text-[#8C1515] cursor-pointer select-none">
                Read the full text ({s.fullText.length.toLocaleString()}{" "}
                characters)
              </summary>
              <div
                className="mt-3 text-sm text-[#572020] leading-relaxed whitespace-pre-wrap max-h-[60vh] overflow-y-auto"
                data-testid="source-full-text"
              >
                {s.fullText}
              </div>
            </details>
          )}
        </section>
      )}

      {/* Interpretations — the heart of the page. */}
      <section className="mb-12">
        <InterpretationsTab sourceId={s.id} pillarSlug={slug} />
      </section>

      {/* Scientific reliability — supporting assessment of the paper itself. */}
      <section className="mb-12">
        <ReliabilityPanel slug={slug} id={id} />
      </section>

      {/* Technical detail, tucked away at the bottom. */}
      <section className="mb-6">
        <details className="group">
          <summary className="font-serif text-lg cursor-pointer select-none text-[#572020]">
            How the system indexed this paper ({data.chunkCount} passages)
          </summary>
          <p className="text-xs text-[#8a6a5a] mt-2 mb-3 max-w-2xl leading-relaxed">
            To let the AI search this paper, the system split it into short
            passages and stored a numeric fingerprint (an embedding) of each
            one. The embeddings stay on the server — only the text passages are
            shown here. Showing the first {data.chunks.length} of{" "}
            {data.chunkCount}.
          </p>
          <div className="space-y-3">
            {data.chunks.map((c) => (
              <div
                key={c.id}
                className="border border-[#E8DDD0] rounded p-3 text-xs text-[#572020]"
                data-testid={`chunk-${c.chunkIndex}`}
              >
                <p className="text-[10px] text-[#8a6a5a] mb-1">
                  #{c.chunkIndex}
                  {c.page != null && ` · p.${c.page}`}
                  {c.section && ` · ${c.section}`}
                </p>
                <p className="whitespace-pre-wrap leading-relaxed">
                  {c.text.slice(0, 600)}
                  {c.text.length > 600 && "…"}
                </p>
              </div>
            ))}
          </div>
        </details>
      </section>

      <section className="mb-8">
        <details className="group">
          <summary className="font-serif text-lg cursor-pointer select-none text-[#572020]">
            Change history ({data.audit.length})
          </summary>
          <ul className="text-xs text-[#8a6a5a] space-y-1 mt-3">
            {data.audit.map((a) => (
              <li key={a.id}>
                {new Date(a.createdAt).toLocaleString()} — {a.action}
                {a.fromStatus &&
                  a.toStatus &&
                  `: ${a.fromStatus} → ${a.toStatus}`}
                {a.note && ` — ${a.note}`}
              </li>
            ))}
          </ul>
        </details>
      </section>
    </PortalShell>
  );
}

// ---------- Reliability assessment ----------

interface AssessmentResponse {
  assessmentStatus: "draft" | "approved" | null;
  rubric: ReliabilityRubric | null;
  scores: Record<ReliabilityAxisKey, AxisScore> | null;
  aiDraft: ReliabilityRubric | null;
  aiAcceptance: "no_draft" | "unedited" | "light" | "rewritten" | null;
  assessedAt: string | null;
  assessedByName: string | null;
  canEdit: boolean;
}

const AI_ACCEPTANCE_LABEL: Record<string, string> = {
  no_draft: "Assessed by hand (no AI draft used)",
  unedited: "AI draft approved without edits",
  light: "Lightly edited from the AI draft",
  rewritten: "Substantially rewritten from the AI draft",
};

const ANSWER_LABEL: Record<ReliabilityAnswer, string> = {
  yes: "Yes",
  partial: "Partial",
  no: "No",
  unclear: "Unclear",
};

const ANSWER_COLORS: Record<
  ReliabilityAnswer,
  { fg: string; bg: string; border: string }
> = {
  yes: { fg: "#2f7d41", bg: "#EAF3EC", border: "#CBE3D1" },
  partial: { fg: "#8a6b14", bg: "#F6EFD9", border: "#E7D9AE" },
  no: { fg: "#9a3325", bg: "#F6E6E2", border: "#E8CFC8" },
  unclear: { fg: "#8a6a5a", bg: "#F4ECDD", border: "#E8DDC8" },
};

function ReliabilityStatusPill({
  status,
}: {
  status: "draft" | "approved" | null;
}) {
  const map = {
    approved: {
      text: "Approved · public",
      ...RELIABILITY_BAND_COLORS.strong,
    },
    draft: {
      text: "Draft · not public",
      ...RELIABILITY_BAND_COLORS.moderate,
    },
    none: {
      text: "Not assessed",
      ...RELIABILITY_BAND_COLORS.unknown,
    },
  };
  const c = map[status ?? "none"];
  return (
    <span
      className="text-[11px] tracking-[0.04em] rounded-full border px-2.5 py-0.5"
      style={{ color: c.fg, background: c.bg, borderColor: c.border }}
      data-testid="reliability-status-pill"
    >
      {c.text}
    </span>
  );
}

function AnswerBadge({ answer }: { answer: ReliabilityAnswer }) {
  const c = ANSWER_COLORS[answer];
  return (
    <span
      className="shrink-0 text-[11px] rounded-full border px-2 py-0.5"
      style={{ color: c.fg, background: c.bg, borderColor: c.border }}
    >
      {ANSWER_LABEL[answer]}
    </span>
  );
}

function AxisMeter({
  label,
  blurb,
  score,
}: {
  label: string;
  blurb: string;
  score: AxisScore;
}) {
  const band = reliabilityBand(score.score);
  const c = RELIABILITY_BAND_COLORS[band];
  return (
    <div data-testid={`axis-meter-${label}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-serif text-[#572020]">{label}</span>
        <span className="text-sm font-medium" style={{ color: c.fg }}>
          {score.score == null ? "Not scored" : `${score.score}%`}
        </span>
      </div>
      <div className="mt-1 h-2 rounded-full bg-[#EFE6D8] overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${score.score ?? 0}%`, background: c.fg }}
        />
      </div>
      <p className="mt-1 text-[11px] text-[#8a6a5a]">
        {reliabilityBandLabel(band)} · {score.assessed}/{score.total} items
        scored
      </p>
      <p className="mt-0.5 text-[11px] text-[#8a6a5a]">{blurb}</p>
    </div>
  );
}

/**
 * Steward-governed three-axis reliability assessment for one source. AI can
 * draft per-item answers; the steward reviews, edits, and approves. The three
 * axes (Rigor / Reproducibility / Open Science) are scored separately and
 * never collapsed into one number. Nothing here is public until approved.
 */
function ReliabilityPanel({ slug, id }: { slug: string; id: string }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<AssessmentResponse>({
    queryKey: ["faculty-source-assessment", slug, id],
    queryFn: () =>
      fetchJson(`/api/faculty/pillars/${slug}/sources/${id}/assessment`),
  });

  const [rubric, setRubric] = useState<ReliabilityRubric>(emptyRubric());
  const [dirty, setDirty] = useState(false);
  const [draftNote, setDraftNote] = useState<string | null>(null);

  // Mirror the server rubric while there are no unsaved local edits.
  useEffect(() => {
    if (!data || dirty) return;
    setRubric(normalizeRubric(data.rubric));
  }, [data, dirty]);

  const liveScores = useMemo(
    () => ({
      rigor: scoreAxis("rigor", rubric.rigor.items),
      reproducibility: scoreAxis(
        "reproducibility",
        rubric.reproducibility.items,
      ),
      openness: scoreAxis("openness", rubric.openness.items),
    }),
    [rubric],
  );

  const draftMut = useMutation({
    mutationFn: () =>
      fetchJson<{ generated?: boolean }>(
        `/api/faculty/pillars/${slug}/sources/${id}/assessment/draft`,
        { method: "POST" },
      ),
    onSuccess: (res) => {
      setDirty(false);
      setDraftNote(
        res?.generated === false
          ? "The AI scorer is unavailable right now. Assess each item by hand, then publish when ready."
          : null,
      );
      qc.invalidateQueries({
        queryKey: ["faculty-source-assessment", slug, id],
      });
    },
  });

  // Re-draft a SINGLE axis with the AI, merging it into the current rubric so
  // the steward's work on the other two axes is preserved.
  const recalcAxisMut = useMutation({
    mutationFn: (axis: ReliabilityAxisKey) =>
      fetchJson<{ generated?: boolean }>(
        `/api/faculty/pillars/${slug}/sources/${id}/assessment/draft`,
        { method: "POST", body: JSON.stringify({ axis }) },
      ),
    onSuccess: (res) => {
      setDirty(false);
      setDraftNote(
        res?.generated === false
          ? "The AI scorer is unavailable right now. Score this axis by hand, then publish when ready."
          : null,
      );
      qc.invalidateQueries({
        queryKey: ["faculty-source-assessment", slug, id],
      });
    },
  });

  const saveMut = useMutation({
    mutationFn: (status: "draft" | "approved") =>
      fetchJson(`/api/faculty/pillars/${slug}/sources/${id}/assessment`, {
        method: "PUT",
        body: JSON.stringify({ rubric, status }),
      }),
    onSuccess: () => {
      setDirty(false);
      setDraftNote(null);
      qc.invalidateQueries({
        queryKey: ["faculty-source-assessment", slug, id],
      });
      qc.invalidateQueries({ queryKey: ["faculty-sources", slug] });
    },
  });

  const setItemAnswer = (
    axis: ReliabilityAxisKey,
    itemId: string,
    answer: ReliabilityAnswer,
  ) => {
    setDirty(true);
    setRubric((prev) => ({
      ...prev,
      [axis]: {
        items: prev[axis].items.map((it) =>
          it.id === itemId ? { ...it, answer } : it,
        ),
      },
    }));
  };

  const setItemRationale = (
    axis: ReliabilityAxisKey,
    itemId: string,
    rationale: string,
  ) => {
    setDirty(true);
    setRubric((prev) => ({
      ...prev,
      [axis]: {
        items: prev[axis].items.map((it) =>
          it.id === itemId ? { ...it, rationale } : it,
        ),
      },
    }));
  };

  const canEdit = data?.canEdit ?? false;
  const status = data?.assessmentStatus ?? null;
  const busy =
    draftMut.isPending || saveMut.isPending || recalcAxisMut.isPending;

  const itemFor = (axis: ReliabilityAxisKey, itemId: string) =>
    rubric[axis].items.find((i) => i.id === itemId) ?? {
      id: itemId,
      answer: "unclear" as ReliabilityAnswer,
      rationale: "",
    };

  return (
    <section className="mb-8" data-testid="reliability-panel">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
        <h2 className="font-serif text-lg">Scientific reliability</h2>
        <ReliabilityStatusPill status={status} />
      </div>
      <p className="text-xs text-[#8a6a5a] mb-3 max-w-2xl leading-relaxed">
        Three independent axes, each scored against its own fixed checklist and
        never combined into a single number. Scores describe the paper, not the
        steward. Each axis score is the share of its checklist items you mark{" "}
        <span className="text-[#572020]">Yes</span> (full credit) or{" "}
        <span className="text-[#572020]">Partial</span> (half); items marked{" "}
        <span className="text-[#572020]">Unclear</span> are left out of the
        math, so an axis is only as strong as the items you could actually
        judge. Nothing is shown to readers until you publish it.
      </p>
      <div className="mb-5 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-[#8a6a5a]">What the score means:</span>
        {(
          [
            ["strong", "75–100%"],
            ["moderate", "45–74%"],
            ["limited", "0–44%"],
          ] as const
        ).map(([band, range]) => {
          const c = RELIABILITY_BAND_COLORS[band];
          return (
            <span
              key={band}
              className="rounded-full border px-2 py-0.5"
              style={{ color: c.fg, background: c.bg, borderColor: c.border }}
            >
              {reliabilityBandLabel(band)} · {range}
            </span>
          );
        })}
      </div>

      {isLoading && <p className="text-sm text-[#8a6a5a]">Loading…</p>}
      {error && (
        <p className="text-sm text-[#E8352A]">{(error as Error).message}</p>
      )}

      {data && (
        <>
          <div className="grid gap-5 sm:grid-cols-3 mb-6">
            {RELIABILITY_AXES.map((axis) => (
              <AxisMeter
                key={axis.key}
                label={axis.label}
                blurb={axis.blurb}
                score={liveScores[axis.key]}
              />
            ))}
          </div>

          {!canEdit && !status ? (
            <p className="text-sm text-[#8a6a5a] italic">
              This source has not been assessed yet.
            </p>
          ) : (
            <div className="space-y-6">
              {RELIABILITY_AXES.map((axis) => {
                const axisScore = liveScores[axis.key];
                const axisBand = reliabilityBand(axisScore.score);
                const axisBandColor = RELIABILITY_BAND_COLORS[axisBand];
                const recalcPending =
                  recalcAxisMut.isPending &&
                  recalcAxisMut.variables === axis.key;
                return (
                  <div key={axis.key}>
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <h3 className="font-serif text-[#572020]">
                            {axis.label}
                          </h3>
                          <span
                            className="text-xs font-medium"
                            style={{ color: axisBandColor.fg }}
                          >
                            {axisScore.score == null
                              ? "Not scored"
                              : `${axisScore.score}% · ${reliabilityBandLabel(
                                  axisBand,
                                )}`}
                          </span>
                        </div>
                        <p className="text-[11px] text-[#8a6a5a] mt-0.5 max-w-md">
                          {axis.blurb}
                        </p>
                      </div>
                      {canEdit && (
                        <button
                          onClick={() => recalcAxisMut.mutate(axis.key)}
                          disabled={busy || dirty}
                          className="shrink-0 text-xs border border-[#E8DDD0] hover:border-[#8C1515] px-2.5 py-1 rounded disabled:opacity-50"
                          data-testid={`button-recalc-${axis.key}`}
                          title={
                            dirty
                              ? "Save your edits first — recalculating one axis re-reads the saved version, so unsaved changes to the other axes would be lost."
                              : `Re-run the AI on just the ${axis.label} checklist`
                          }
                        >
                          {recalcPending
                            ? "Recalculating…"
                            : "Recalculate with AI"}
                        </button>
                      )}
                    </div>
                    <div className="space-y-2.5">
                      {axis.items.map((itemDef) => {
                        const ans = itemFor(axis.key, itemDef.id);
                        return (
                          <div
                            key={itemDef.id}
                            className="border border-[#E8DDD0] rounded p-3 bg-[#FFFDF8]"
                            data-testid={`assessment-item-${itemDef.id}`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-sm text-[#572020]">
                                  {itemDef.label}
                                </p>
                                <p className="text-[11px] text-[#8a6a5a] mt-0.5">
                                  {itemDef.help}
                                </p>
                              </div>
                              {canEdit ? (
                                <select
                                  value={ans.answer}
                                  onChange={(e) =>
                                    setItemAnswer(
                                      axis.key,
                                      itemDef.id,
                                      e.target.value as ReliabilityAnswer,
                                    )
                                  }
                                  className="shrink-0 text-sm rounded border border-[#E8DDD0] bg-white px-2 py-1 text-[#572020]"
                                  data-testid={`answer-${itemDef.id}`}
                                >
                                  {RELIABILITY_ANSWERS.map((a) => (
                                    <option key={a} value={a}>
                                      {ANSWER_LABEL[a]}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <AnswerBadge answer={ans.answer} />
                              )}
                            </div>
                            {canEdit ? (
                              <input
                                type="text"
                                value={ans.rationale}
                                onChange={(e) =>
                                  setItemRationale(
                                    axis.key,
                                    itemDef.id,
                                    e.target.value,
                                  )
                                }
                                placeholder="One-line rationale describing the paper"
                                className="mt-2 w-full text-sm rounded border border-[#E8DDD0] bg-white px-2 py-1 text-[#572020] placeholder:text-[#b8a898]"
                                data-testid={`rationale-${itemDef.id}`}
                              />
                            ) : (
                              ans.rationale && (
                                <p className="mt-1.5 text-xs text-[#572020] italic">
                                  {ans.rationale}
                                </p>
                              )
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {canEdit && (
            <div className="mt-6 border-t border-[#E8DDD0] pt-5">
              {/* Reader-visibility explainer: the steward owns the publish
                  decision, separate from saving their work. */}
              <div
                className="rounded-lg border px-3 py-2 mb-3 text-xs leading-relaxed"
                style={
                  status === "approved"
                    ? {
                        background: "#EAF3EC",
                        borderColor: "#CBE3D1",
                        color: "#2f7d41",
                      }
                    : {
                        background: "#F4ECDD",
                        borderColor: "#E8DDC8",
                        color: "#8a6a5a",
                      }
                }
                data-testid="reliability-visibility"
              >
                {status === "approved" ? (
                  <>
                    <strong>Published to readers.</strong> These scores now
                    appear next to this paper in your pillar agent's answers.
                    (Publishing doesn't re-index the paper — that already
                    happened when it was added; it only controls whether readers
                    see this assessment.) Unpublish to pull them back to a
                    private draft.
                  </>
                ) : (
                  <>
                    <strong>Private to your team.</strong> These scores are
                    visible only inside this portal. Publishing won't re-index
                    the paper — it just decides whether readers see this
                    assessment. You choose if and when.
                  </>
                )}
              </div>
              <p className="text-xs text-[#8a6a5a] leading-relaxed max-w-2xl">
                <span className="font-medium text-[#572020]">
                  Draft all with AI
                </span>{" "}
                fills in the checklist from the paper's own text for you to
                review — it never publishes anything.{" "}
                <span className="font-medium text-[#572020]">
                  Save privately
                </span>{" "}
                keeps your work as a team-only draft.{" "}
                <span className="font-medium text-[#572020]">
                  Publish to readers
                </span>{" "}
                makes these scores public next to the paper in answers.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={() => draftMut.mutate()}
                  disabled={busy}
                  className="px-3 py-1.5 rounded border border-[#E8DDD0] text-[#572020] hover:border-[#8C1515] disabled:opacity-50"
                  data-testid="button-ai-draft"
                >
                  {draftMut.isPending ? "Drafting…" : "Draft all with AI"}
                </button>
                {status !== "approved" && (
                  <button
                    onClick={() => saveMut.mutate("draft")}
                    disabled={busy}
                    className="px-3 py-1.5 rounded border border-[#E8DDD0] text-[#572020] hover:border-[#8C1515] disabled:opacity-50"
                    data-testid="button-save-draft"
                  >
                    Save privately
                  </button>
                )}
                <button
                  onClick={() => saveMut.mutate("approved")}
                  disabled={busy}
                  className="px-3 py-1.5 rounded bg-[#8C1515] text-white hover:bg-[#a01a1a] disabled:opacity-50"
                  data-testid="button-approve"
                >
                  {status === "approved"
                    ? "Update published scores"
                    : "Publish to readers"}
                </button>
                {status === "approved" && (
                  <button
                    onClick={() => saveMut.mutate("draft")}
                    disabled={busy}
                    className="px-3 py-1.5 rounded border border-[#E8DDD0] text-[#572020] hover:border-[#8C1515] disabled:opacity-50"
                    data-testid="button-unpublish"
                  >
                    Unpublish
                  </button>
                )}
                {dirty && (
                  <span className="text-[11px] text-[#8a6b14]">
                    Unsaved edits
                  </span>
                )}
              </div>
              {draftNote && (
                <p className="mt-2 text-xs text-[#8a6b14]">{draftNote}</p>
              )}
              {(draftMut.error || saveMut.error || recalcAxisMut.error) && (
                <p className="mt-2 text-xs text-[#E8352A]">
                  {
                    (
                      (draftMut.error ||
                        saveMut.error ||
                        recalcAxisMut.error) as Error
                    ).message
                  }
                </p>
              )}
            </div>
          )}

          {data.assessedAt && (
            <p className="mt-3 text-[11px] text-[#8a6a5a]">
              Published
              {data.assessedByName && ` by ${data.assessedByName}`}
              {` · ${new Date(data.assessedAt).toLocaleDateString()}`}
              {data.aiAcceptance &&
                ` · ${AI_ACCEPTANCE_LABEL[data.aiAcceptance]}`}
            </p>
          )}
        </>
      )}
    </section>
  );
}

// ---------- Interpretations ----------

interface Interpretation {
  id: number;
  status: "proposed" | "approved" | "archived";
  version: number;
  answer: string;
  interpretation: string;
  notProven: string | null;
  action: string | null;
  tags: string[];
  authorId: number | null;
  authorName: string | null;
  authorEmail: string | null;
  origin: "palonur_ai" | "faculty";
  draftedAt: string | null;
  reviewedByUserId: number | null;
  reviewedAt: string | null;
  lastEditedByUserId: number | null;
  lastEditedAt: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface InterpretationsResponse {
  interpretations: Interpretation[];
  role: "steward" | "contributor" | "advisor" | "viewer" | null;
  pillar: { id: number; slug: string; name: string };
}

interface InterpretationComment {
  id: number;
  body: string;
  quotedText: string | null;
  parentCommentId: number | null;
  authorId: number | null;
  authorName: string | null;
  authorEmail: string | null;
  createdAt: string;
}

const INTERP_STATUS_COLOR: Record<Interpretation["status"], string> = {
  proposed: "#d4af37",
  approved: "#3a9a4f",
  archived: "#5a5a52",
};

// Plain-language meaning of each interpretation status, shown right under the
// badge on each card so it's obvious what state a reading is in and who can see
// it — without needing a separate legend.
const INTERP_STATUS_MEANING: Record<Interpretation["status"], string> = {
  proposed:
    "Draft answer — visible to your team, waiting for a steward to approve it before readers and the AI can see it.",
  approved:
    "Live — The AI can cite this in answers to readers. Your team stands behind it.",
  archived:
    "Retired — kept for the record but no longer used in any answer to readers.",
};

// Soft status tints behind the status chip, and the capitalized label. Paired
// with INTERP_STATUS_COLOR so the chip reads as a quiet, on-brand pill rather
// than a loud outlined badge.
const INTERP_STATUS_BG: Record<Interpretation["status"], string> = {
  proposed: "#FBF8F0",
  approved: "#F2F9F4",
  archived: "#F4F4F3",
};

const INTERP_STATUS_LABEL: Record<Interpretation["status"], string> = {
  proposed: "Proposed",
  approved: "Approved",
  archived: "Archived",
};

// Small inline stroke icons (the app has no icon library; it uses inline SVGs).
// All take a className so the caller controls size + colour via currentColor.
function IconPlus({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function IconCheck({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function IconSendBack({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </svg>
  );
}

function IconReopen({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function IconPencil({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
    </svg>
  );
}

function IconArchive({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

function IconHistory({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

function IconDiscuss({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function IconColleagues({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function InterpretationStatusBadge({
  status,
}: {
  status: Interpretation["status"];
}) {
  return (
    <span
      className="inline-flex items-center rounded-md px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]"
      style={{
        backgroundColor: INTERP_STATUS_BG[status],
        color: INTERP_STATUS_COLOR[status],
      }}
      data-testid={`badge-interp-status-${status}`}
    >
      {INTERP_STATUS_LABEL[status]}
    </span>
  );
}

interface InterpretationDraft {
  answer: string;
  interpretation: string;
  notProven: string;
  action: string;
  tagsInput: string;
}

const EMPTY_DRAFT: InterpretationDraft = {
  answer: "",
  interpretation: "",
  notProven: "",
  action: "",
  tagsInput: "",
};

function draftToBody(d: InterpretationDraft): {
  answer: string;
  interpretation: string;
  notProven: string | null;
  action: string | null;
  tags: string[];
} {
  return {
    answer: d.answer.trim(),
    interpretation: d.interpretation.trim(),
    notProven: d.notProven.trim() || null,
    action: d.action.trim() || null,
    tags: d.tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  };
}

interface SourceChunkRef {
  chunkIndex: number;
  text: string;
}

// Tiny English stopword list — enough to keep word-overlap from being
// dominated by "the", "and", "of", etc. Not exhaustive on purpose; the
// goal is "good enough to pick the right chunk", not perfect IR.
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "then",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "from",
  "as",
  "that",
  "this",
  "these",
  "those",
  "it",
  "its",
  "we",
  "you",
  "they",
  "their",
  "our",
  "your",
  "i",
  "do",
  "does",
  "did",
  "not",
  "no",
  "than",
  "so",
  "such",
  "can",
  "may",
  "might",
  "will",
  "would",
  "should",
  "have",
  "has",
  "had",
  "into",
  "about",
  "up",
  "down",
  "out",
  "over",
  "under",
  "more",
  "most",
  "less",
  "least",
  "also",
  "been",
  "between",
  "among",
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

/**
 * Split prose into sentences and, for each, return the index of the
 * chunk it most overlaps with (or null if no chunk has any overlap).
 * Returns the same number of entries as sentences, in document order.
 */
function mapSentencesToChunks(
  prose: string,
  chunks: SourceChunkRef[],
): Array<{ sentence: string; chunkIdx: number | null; score: number }> {
  // Strip the AI_DRAFT_PREFIX wrapper line if present so we don't try
  // to map the disclaimer banner.
  const body = prose.replace(/^\[AI-drafted[^\]]*\]\s*/u, "").trim();
  if (!body || chunks.length === 0) return [];
  const sentences = body
    .split(/(?<=[.!?])\s+(?=[A-Z(])/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunkTokens = chunks.map((c) => tokenize(c.text));
  return sentences.map((sentence) => {
    const sTokens = tokenize(sentence);
    let bestIdx: number | null = null;
    let bestScore = 0;
    chunkTokens.forEach((ct, i) => {
      const score = jaccard(sTokens, ct);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    });
    return {
      sentence,
      chunkIdx: bestScore > 0.05 ? bestIdx : null,
      score: bestScore,
    };
  });
}

// Distinct accent colours per chunk index — used to colour the
// sentence's left-bar AND the matching chunk card so the steward can
// follow the eye-line. Cycles after 5 chunks (we only fetch 5 today).
const CHUNK_COLORS = [
  "#E8352A", // stanford red
  "#D4A017", // gold
  "#3B82F6", // blue
  "#10B981", // green
  "#A855F7", // purple
];

function chunkColor(idx: number | null): string {
  if (idx == null) return "#3a3a3a";
  return CHUNK_COLORS[idx % CHUNK_COLORS.length]!;
}

function InterpretationEditor({
  sourceId,
  initial,
  interpretationId,
  onDone,
  pillarSlug,
}: {
  sourceId: number;
  initial?: Interpretation;
  interpretationId?: number;
  onDone: () => void;
  pillarSlug?: string;
}) {
  const qc = useQueryClient();
  const { data: meForFramework } = useMe();
  const bookerPillarId = useMemo(
    () =>
      pillarSlug
        ? meForFramework?.pillars.find((p) => p.slug === pillarSlug)?.id
        : undefined,
    [meForFramework, pillarSlug],
  );
  const [draft, setDraft] = useState<InterpretationDraft>(
    initial
      ? {
          answer: initial.answer,
          interpretation: initial.interpretation,
          notProven: initial.notProven ?? "",
          action: initial.action ?? "",
          tagsInput: initial.tags.join(", "),
        }
      : EMPTY_DRAFT,
  );
  const [msg, setMsg] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      fetchJson<Interpretation>(
        `/api/faculty/sources/${sourceId}/interpretations`,
        { method: "POST", body: JSON.stringify(draftToBody(draft)) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["faculty-interpretations", sourceId],
      });
      setMsg("Saved as proposed.");
      onDone();
    },
    onError: (e: Error) => setMsg(`Error: ${e.message}`),
  });

  const update = useMutation({
    mutationFn: () =>
      fetchJson<Interpretation>(
        `/api/faculty/interpretations/${interpretationId}`,
        { method: "PATCH", body: JSON.stringify(draftToBody(draft)) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["faculty-interpretations", sourceId],
      });
      setMsg("Updated.");
      onDone();
    },
    onError: (e: Error) => setMsg(`Error: ${e.message}`),
  });

  const isEdit = !!interpretationId;
  const valid =
    draft.answer.trim().length > 0 && draft.interpretation.trim().length > 0;

  // Source chunks the AI drafter saw — shown in a side panel so the
  // steward can fact-check the draft sentence-by-sentence without
  // re-reading the paper. Loaded lazily for existing interpretations
  // (the new-interpretation flow has no source draft to back-reference).
  const [chunks, setChunks] = useState<SourceChunkRef[]>([]);
  const chunksQuery = useQuery<{
    sourceId: number;
    question: string;
    chunks: SourceChunkRef[];
  }>({
    queryKey: ["interp-source-chunks", interpretationId, draft.answer.trim()],
    enabled: !!interpretationId && draft.answer.trim().length > 0,
    queryFn: () =>
      fetchJson(
        `/api/faculty/interpretations/${interpretationId}/source-chunks?question=${encodeURIComponent(draft.answer.trim())}`,
      ),
    staleTime: 60_000,
  });
  // Mirror query results into local state so a successful redraft (which
  // returns its own chunks) immediately replaces what the side panel shows.
  useEffect(() => {
    if (chunksQuery.data?.chunks) setChunks(chunksQuery.data.chunks);
  }, [chunksQuery.data]);

  const redraft = useMutation({
    mutationFn: () =>
      fetchJson<{
        draft: string;
        usedChunks: number;
        chunks: SourceChunkRef[];
      }>(`/api/faculty/interpretations/${interpretationId}/redraft`, {
        method: "POST",
        body: JSON.stringify({ question: draft.answer.trim() || undefined }),
      }),
    onSuccess: (data) => {
      setDraft((d) => ({ ...d, interpretation: data.draft }));
      if (Array.isArray(data.chunks)) setChunks(data.chunks);
      setMsg(
        `AI draft rewritten from ${data.usedChunks} source chunk${data.usedChunks === 1 ? "" : "s"}.`,
      );
    },
    onError: (e: Error) => setMsg(`Rewrite failed: ${e.message}`),
  });

  // Map each sentence in the interpretation prose to its best-matching
  // source chunk by simple word overlap (Jaccard on lowercased
  // alphanumeric tokens, stopwords stripped). Cheap, deterministic,
  // runs in the browser. Good enough to colour-code which chunk a
  // sentence leans on; the steward still verifies by reading.
  const sentenceMap = useMemo(
    () => mapSentencesToChunks(draft.interpretation, chunks),
    [draft.interpretation, chunks],
  );

  // Refs to each chunk <li> in the side panel so a sentence-row click can
  // scroll its source passage into view. Re-assigned on every render; the
  // length tracks `chunks` so it survives a redraft.
  const chunkRefs = useRef<Array<HTMLLIElement | null>>([]);
  // Briefly flashes the chunk card the steward just clicked through to,
  // and the chunk currently being hovered (so the sentence-row highlight
  // has something visual to anchor to). Cleared by a setTimeout.
  const [flashChunkIdx, setFlashChunkIdx] = useState<number | null>(null);
  // Reverse direction: hovering a chunk card highlights every sentence
  // row that maps to it.
  const [hoverChunkIdx, setHoverChunkIdx] = useState<number | null>(null);

  const focusChunk = (idx: number | null) => {
    if (idx == null) return;
    const el = chunkRefs.current[idx];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setFlashChunkIdx(idx);
    window.setTimeout(() => {
      setFlashChunkIdx((cur) => (cur === idx ? null : cur));
    }, 1500);
  };

  const showSidePanel = isEdit;

  return (
    <div
      className={
        showSidePanel
          ? "border border-[#E8DDD0] rounded-xl p-5 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)] lg:gap-6"
          : "border border-[#E8DDD0] rounded-xl p-5 space-y-3"
      }
      data-testid="interpretation-editor"
    >
      <div className="space-y-3 min-w-0">
        <h3 className="font-serif text-lg text-[#572020]">
          {isEdit ? "Edit interpretation" : "Write a faculty interpretation"}
        </h3>
        <p className="text-xs text-[#8a6a5a] leading-relaxed">
          {isEdit
            ? "Refine the reading below. Use “Draft with AI from the paper” to get a fresh first pass written from the source — then make it your own."
            : "Write a plain-language reading of this paper. It saves as a private draft (“proposed”) that your team can see and discuss — a steward approves it before readers and the AI can use it."}
        </p>
        <label className="block">
          <span className="text-xs text-[#8a6a5a]">
            One-sentence answer (the headline the public sees)
          </span>
          <textarea
            value={draft.answer}
            onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
            rows={2}
            className="w-full mt-1 bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm"
            data-testid="textarea-answer"
          />
        </label>
        <label className="block">
          <span className="text-xs text-[#8a6a5a]">
            Plain-language reading of the paper
          </span>
          <textarea
            value={draft.interpretation}
            onChange={(e) =>
              setDraft({ ...draft, interpretation: e.target.value })
            }
            rows={5}
            className="w-full mt-1 bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm"
            data-testid="textarea-interpretation"
          />
          {showSidePanel && sentenceMap.length > 0 && (
            <div
              className="mt-2 space-y-1.5 text-xs"
              data-testid="sentence-chunk-map"
            >
              <div className="text-[10px] uppercase tracking-wider text-[#6a6a62]">
                Sentence → source passage
              </div>
              {sentenceMap.map((s, i) => {
                const isHovered =
                  hoverChunkIdx != null && s.chunkIdx === hoverChunkIdx;
                const clickable = s.chunkIdx != null;
                return (
                  <div
                    key={i}
                    role={clickable ? "button" : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={
                      clickable ? () => focusChunk(s.chunkIdx) : undefined
                    }
                    onKeyDown={
                      clickable
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              focusChunk(s.chunkIdx);
                            }
                          }
                        : undefined
                    }
                    className={
                      "pl-2 border-l-2 text-[#572020] leading-snug rounded-sm transition-colors " +
                      (clickable ? "cursor-pointer hover:bg-[#F4ECDF] " : "") +
                      (isHovered ? "bg-[#F4ECDF]" : "")
                    }
                    style={{ borderColor: chunkColor(s.chunkIdx) }}
                    data-testid={`sentence-chunk-${i}`}
                    data-chunk-idx={s.chunkIdx ?? ""}
                    title={
                      s.chunkIdx == null
                        ? "No matching passage — verify by re-reading the paper"
                        : `Click to jump to passage ${s.chunkIdx + 1} (overlap ${s.score.toFixed(2)})`
                    }
                  >
                    <span
                      className="text-[10px] font-mono mr-1"
                      style={{ color: chunkColor(s.chunkIdx) }}
                    >
                      {s.chunkIdx == null ? "?" : `#${s.chunkIdx + 1}`}
                    </span>
                    {s.sentence}
                  </div>
                );
              })}
            </div>
          )}
        </label>
        <label className="block">
          <span className="text-xs text-[#8a6a5a]">
            What the paper does NOT prove
          </span>
          <textarea
            value={draft.notProven}
            onChange={(e) => setDraft({ ...draft, notProven: e.target.value })}
            rows={3}
            className="w-full mt-1 bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm"
            data-testid="textarea-not-proven"
          />
        </label>
        <label className="block">
          <span className="text-xs text-[#8a6a5a]">
            Recommended-action snippet
          </span>
          <textarea
            value={draft.action}
            onChange={(e) => setDraft({ ...draft, action: e.target.value })}
            rows={2}
            className="w-full mt-1 bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm"
            data-testid="textarea-action"
          />
        </label>
        <label className="block">
          <span className="text-xs text-[#8a6a5a]">
            Tags (comma-separated topic keywords for routing)
          </span>
          <input
            value={draft.tagsInput}
            onChange={(e) => setDraft({ ...draft, tagsInput: e.target.value })}
            placeholder="caffeine, half-life, sleep onset"
            className="w-full mt-1 bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm"
            data-testid="input-tags"
          />
        </label>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => (isEdit ? update.mutate() : create.mutate())}
            disabled={!valid || create.isPending || update.isPending}
            className="bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] disabled:opacity-50"
            data-testid="button-save-interpretation"
          >
            {create.isPending || update.isPending
              ? "Saving…"
              : isEdit
                ? "Save changes"
                : "Save privately"}
          </button>
          {isEdit && (
            <button
              type="button"
              onClick={() => redraft.mutate()}
              disabled={redraft.isPending || draft.answer.trim().length === 0}
              className="text-xs border border-[#E8DDD0] text-[#8a6a5a] hover:text-[#572020] hover:border-[#4a4a4a] px-3 py-2 rounded-lg disabled:opacity-50"
              title="Ask the AI to write a fresh draft of this interpretation from the paper, using your one-sentence answer as the question. It only fills the fields below for you to review — it never publishes."
              data-testid="button-rewrite-draft"
            >
              {redraft.isPending
                ? "Drafting…"
                : "✨ Draft with AI from the paper"}
            </button>
          )}
          <button
            onClick={onDone}
            className="text-sm text-[#8a6a5a] hover:text-[#572020] px-3 py-2"
            data-testid="button-cancel-interpretation"
          >
            Cancel
          </button>
          {msg && (
            <span
              className="text-xs text-[#8a6a5a] ml-2"
              data-testid="text-interp-msg"
            >
              {msg}
            </span>
          )}
        </div>
        <FrameworkApplyPanel
          kind="answer"
          draft={draft.interpretation || draft.answer}
          onUseDraft={(text) => setDraft({ ...draft, interpretation: text })}
          booking={
            bookerPillarId
              ? {
                  bookerPillarId,
                  targetType: "interpretation",
                  targetId: interpretationId,
                  targetTitle: draft.answer || undefined,
                }
              : undefined
          }
        />
      </div>
      {showSidePanel && (
        <aside
          className="mt-6 lg:mt-0 lg:border-l lg:border-[#E8DDD0] lg:pl-6"
          data-testid="source-chunks-panel"
        >
          <div className="sticky top-4 space-y-3">
            <div>
              <h4 className="font-serif text-sm">Source passages</h4>
              <p className="text-[11px] text-[#6a6a62] leading-relaxed mt-1">
                The top 5 chunks the AI drafter saw, ranked by similarity to the
                headline question. Each sentence above is colour-coded to its
                best-matching passage so you can spot-check the draft without
                re-reading the paper.
              </p>
            </div>
            {chunksQuery.isLoading && (
              <p className="text-xs text-[#6a6a62] italic">Loading passages…</p>
            )}
            {!chunksQuery.isLoading && chunks.length === 0 && (
              <p className="text-xs text-[#6a6a62] italic">
                No embedded passages for this source yet — add the paper's
                text/PDF and re-draft to populate.
              </p>
            )}
            <ol className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
              {chunks.map((c, i) => (
                <li
                  key={`${c.chunkIndex}-${i}`}
                  ref={(el) => {
                    chunkRefs.current[i] = el;
                  }}
                  onMouseEnter={() => setHoverChunkIdx(i)}
                  onMouseLeave={() =>
                    setHoverChunkIdx((cur) => (cur === i ? null : cur))
                  }
                  className={
                    "border rounded-lg p-2.5 text-xs bg-[#F9F5EE] transition-shadow " +
                    (flashChunkIdx === i
                      ? "ring-2 ring-offset-2 ring-offset-white shadow-lg "
                      : "") +
                    (hoverChunkIdx === i ? "shadow-md " : "")
                  }
                  style={{
                    borderColor: chunkColor(i),
                    ...(flashChunkIdx === i
                      ? { boxShadow: `0 0 0 2px ${chunkColor(i)}` }
                      : {}),
                  }}
                  data-testid={`source-chunk-${i}`}
                  data-flash={flashChunkIdx === i ? "true" : undefined}
                >
                  <div
                    className="text-[10px] font-mono uppercase tracking-wider mb-1"
                    style={{ color: chunkColor(i) }}
                  >
                    Passage #{i + 1} · chunk {c.chunkIndex}
                  </div>
                  <div className="text-[#572020] whitespace-pre-wrap leading-snug">
                    {c.text}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </aside>
      )}
    </div>
  );
}

interface InterpretationVersion {
  id: number;
  interpretationId: number;
  version: number;
  approverId: number | null;
  approvedAt: string;
  snapshot: {
    event?: string;
    fromStatus?: string;
    toStatus?: string;
    note?: string | null;
    answer?: string;
    interpretation?: string;
    notProven?: string | null;
    action?: string | null;
    tags?: string[];
    parentInterpretationId?: number | null;
    supersededIds?: number[];
  };
}

function InterpretationVersionHistory({
  interpretationId,
}: {
  interpretationId: number;
}) {
  const { data } = useQuery<{ versions: InterpretationVersion[] }>({
    queryKey: ["interp-versions", interpretationId],
    queryFn: () =>
      fetchJson(`/api/faculty/interpretations/${interpretationId}/versions`),
  });
  if (!data) return null;
  if (data.versions.length === 0) {
    return (
      <p className="text-xs text-[#8a6a5a] italic">
        No version history yet — this draft has never been transitioned.
      </p>
    );
  }
  return (
    <ol className="space-y-3">
      {data.versions.map((v) => {
        const event = v.snapshot.event ?? "approved";
        const eventColor =
          event === "approved"
            ? "#3a9a4f"
            : event === "retracted"
              ? "#E8352A"
              : event === "sent_back"
                ? "#d4af37"
                : "#9a9a92";
        return (
          <li
            key={v.id}
            className="border border-[#E8DDD0] rounded-lg p-3 text-xs"
            data-testid={`version-${v.version}`}
          >
            <div className="flex items-baseline justify-between gap-3 mb-2">
              <div className="flex items-baseline gap-2">
                <span
                  className="text-[10px] tracking-[0.2em] uppercase border px-2 py-0.5 rounded"
                  style={{ color: eventColor, borderColor: eventColor }}
                >
                  v{v.version} · {event}
                </span>
                {v.snapshot.fromStatus && v.snapshot.toStatus && (
                  <span className="text-[#8a6a5a]">
                    {v.snapshot.fromStatus} → {v.snapshot.toStatus}
                  </span>
                )}
              </div>
              <span className="text-[#8a6a5a] shrink-0">
                {new Date(v.approvedAt).toLocaleString()}
              </span>
            </div>
            {v.snapshot.note && (
              <p className="text-[#572020] italic mb-2">
                Why: {v.snapshot.note}
              </p>
            )}
            {v.snapshot.answer && (
              <p className="font-serif text-sm text-[#572020] mb-1">
                {v.snapshot.answer}
              </p>
            )}
            {v.snapshot.supersededIds &&
              v.snapshot.supersededIds.length > 0 && (
                <p className="text-[10px] text-[#8a6a5a] mt-1">
                  Superseded #{v.snapshot.supersededIds.join(", #")}
                </p>
              )}
          </li>
        );
      })}
    </ol>
  );
}

function InterpretationDiscussion({
  interpretationId,
  pillarName,
}: {
  interpretationId: number;
  pillarName: string;
}) {
  const qc = useQueryClient();
  const viewAs = useViewAs();
  const [body, setBody] = useState("");
  const [quoted, setQuoted] = useState("");
  const [replyTo, setReplyTo] = useState<InterpretationComment | null>(null);

  const { data } = useQuery<{ comments: InterpretationComment[] }>({
    queryKey: ["interp-comments", interpretationId],
    queryFn: () =>
      fetchJson(`/api/faculty/interpretations/${interpretationId}/comments`),
  });

  const post = useMutation({
    mutationFn: () =>
      fetchJson(`/api/faculty/interpretations/${interpretationId}/comments`, {
        method: "POST",
        body: JSON.stringify({
          body: body.trim(),
          quotedText: quoted.trim() || null,
          parentCommentId: replyTo?.id ?? null,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["interp-comments", interpretationId] });
      setBody("");
      setQuoted("");
      setReplyTo(null);
    },
  });

  // Build a lookup for parent comments so we can show "Replying to …" context.
  const byId = new Map<number, InterpretationComment>();
  for (const c of data?.comments ?? []) byId.set(c.id, c);

  return (
    <div
      className="mt-4 rounded-lg border border-[#E8DDD0] bg-[#FBF7F0] p-4"
      data-testid="interp-discussion"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-1">
        <h3 className="font-serif text-base text-[#572020]">
          Team discussion ({data?.comments.length ?? 0})
        </h3>
        <span className="rounded-full bg-[#F4ECDD] border border-[#E8DDC8] px-2 py-0.5 text-[10px] font-medium text-[#8a6a5a]">
          {pillarName} team only · readers never see this
        </span>
      </div>
      <p className="text-[11px] text-[#8a6a5a] mb-3 max-w-prose">
        A private working space for your pillar team to debate this paper before
        an answer is published. Quote a line, reply to each other, and hash out
        the interpretation together. (To draft the answer itself with AI, use
        “New interpretation”.)
      </p>
      <div className="space-y-3 mb-4">
        {data?.comments.map((c) => {
          const parent = c.parentCommentId ? byId.get(c.parentCommentId) : null;
          return (
            <div
              key={c.id}
              className="border border-[#E8DDD0] rounded p-3 text-xs"
              style={c.parentCommentId ? { marginLeft: 16 } : undefined}
              data-testid={`comment-${c.id}`}
            >
              <div className="text-[#8a6a5a] mb-1 flex items-center gap-2">
                <span>
                  {c.authorName ?? c.authorEmail ?? "anonymous"} ·{" "}
                  {new Date(c.createdAt).toLocaleString()}
                </span>
                {parent && (
                  <span className="text-[10px] text-[#8a6a5a]">
                    ↳ replying to{" "}
                    {parent.authorName ?? parent.authorEmail ?? "anonymous"}
                  </span>
                )}
              </div>
              {c.quotedText && (
                <blockquote className="border-l-2 border-[#8C1515] pl-3 italic text-[#572020] mb-2">
                  {c.quotedText}
                </blockquote>
              )}
              <p className="whitespace-pre-wrap text-[#572020]">{c.body}</p>
              {!viewAs && (
                <button
                  onClick={() => setReplyTo(c)}
                  className="mt-2 text-[10px] text-[#8a6a5a] hover:text-[#572020]"
                  data-testid={`button-reply-${c.id}`}
                >
                  Reply
                </button>
              )}
            </div>
          );
        })}
        {data && data.comments.length === 0 && (
          <p className="text-xs text-[#8a6a5a] italic">No comments yet.</p>
        )}
      </div>
      {viewAs ? (
        <p
          className="text-xs text-[#8a6a5a] italic"
          data-testid="discussion-readonly"
        >
          Read-only preview — you can't post comments while previewing as{" "}
          {viewAs.name}.
        </p>
      ) : (
        <>
          {replyTo && (
            <div
              className="text-[10px] text-[#8a6a5a] mb-2 flex items-center gap-2"
              data-testid="reply-context"
            >
              <span>
                Replying to{" "}
                {replyTo.authorName ?? replyTo.authorEmail ?? "anonymous"}
              </span>
              <button
                onClick={() => setReplyTo(null)}
                className="underline hover:text-[#572020]"
                data-testid="button-cancel-reply"
              >
                cancel
              </button>
            </div>
          )}
          <textarea
            value={quoted}
            onChange={(e) => setQuoted(e.target.value)}
            rows={2}
            placeholder="Optional: paste a quoted snippet from the source"
            className="w-full bg-white border border-[#E8DDD0] rounded px-3 py-2 text-xs mb-2"
            data-testid="textarea-quoted"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={2}
            placeholder={replyTo ? "Write a reply…" : "Add a comment…"}
            className="w-full bg-white border border-[#E8DDD0] rounded px-3 py-2 text-xs"
            data-testid="textarea-comment"
          />
          <button
            onClick={() => body.trim() && post.mutate()}
            disabled={!body.trim() || post.isPending}
            className="mt-2 bg-[#8C1515] text-white px-3 py-1 rounded text-xs font-medium hover:bg-[#a01a1a] disabled:opacity-50"
            data-testid="button-post-comment"
          >
            {post.isPending
              ? "Posting…"
              : replyTo
                ? "Post reply"
                : "Post comment"}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * "Propose adopting this" affordance shown inline on the source page next to an
 * approved interpretation. Lets a steward open a cross-pillar merge request
 * seeded with this interpretation directly, without first navigating to the
 * /explore browser. Reuses the existing cross-pillar merge-request backend
 * (`sourceInterpretationId` + `targetPillarId`). Renders nothing unless the
 * viewer stewards at least one pillar OTHER than this interpretation's pillar.
 */
function ProposeAdoptInline({
  interpretationId,
  sourcePillarSlug,
}: {
  interpretationId: number;
  sourcePillarSlug: string;
}) {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const viewAs = useViewAs();
  const [open, setOpen] = useState(false);
  const [targetPillarId, setTargetPillarId] = useState<number | "">("");
  const [note, setNote] = useState("");

  const myStewardPillars = (me?.pillars ?? []).filter(
    (p) =>
      me?.memberships.find((m) => m.pillarId === p.id)?.role === "steward" &&
      p.slug !== sourcePillarSlug,
  );

  const propose = useMutation({
    mutationFn: () =>
      fetchJson(`/api/faculty/cross-pillar/merge-requests`, {
        method: "POST",
        body: JSON.stringify({
          sourceInterpretationId: interpretationId,
          targetPillarId: Number(targetPillarId),
          note: note.trim() || null,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["merge-requests"] });
      setNote("");
      setTargetPillarId("");
    },
  });

  // Nothing to adopt into — viewer doesn't steward any other pillar.
  if (myStewardPillars.length === 0) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs border border-[#E8DDD0] hover:border-[#8C1515] px-3 py-1 rounded"
        data-testid={`button-propose-adopt-${interpretationId}`}
      >
        Propose adopting this
      </button>
    );
  }

  return (
    <div
      className="mt-3 w-full border border-[#E8DDD0] rounded-lg p-4 bg-[#F9F5EE]"
      data-testid={`card-propose-adopt-${interpretationId}`}
    >
      <p className="text-sm text-[#572020] mb-1 font-medium">
        Adopt into a pillar you steward
      </p>
      <p className="text-xs text-[#8a6a5a] mb-3 max-w-2xl">
        The owning steward reviews it; on approval an attributed copy lands in
        your pillar, crediting the original author.
      </p>
      {propose.isSuccess ? (
        <p
          className="text-sm text-[#572020]"
          data-testid={`text-proposed-${interpretationId}`}
        >
          Proposal sent — track it under{" "}
          <Link href="/requests" className="text-[#8C1515] hover:underline">
            Requests
          </Link>
          .
        </p>
      ) : (
        <div className="space-y-3">
          <select
            value={targetPillarId}
            onChange={(e) =>
              setTargetPillarId(e.target.value ? Number(e.target.value) : "")
            }
            className="w-full border border-[#E8DDD0] rounded px-3 py-2 text-sm bg-white"
            data-testid={`select-target-pillar-${interpretationId}`}
          >
            <option value="">Choose a pillar you steward…</option>
            {myStewardPillars.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note for the owning steward…"
            rows={2}
            className="w-full border border-[#E8DDD0] rounded px-3 py-2 text-sm bg-white"
            data-testid={`input-propose-note-${interpretationId}`}
          />
          {propose.error && (
            <p
              className="text-xs text-[#E8352A]"
              data-testid={`text-propose-error-${interpretationId}`}
            >
              {(propose.error as Error).message}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!targetPillarId || propose.isPending || !!viewAs}
              onClick={() => propose.mutate()}
              className="text-sm bg-[#8C1515] hover:bg-[#a01a1a] disabled:opacity-50 text-white px-4 py-2 rounded transition"
              data-testid={`button-submit-propose-${interpretationId}`}
            >
              {propose.isPending ? "Sending…" : "Propose adoption"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-sm text-[#8a6a5a] hover:text-[#572020] px-3 py-2"
              data-testid={`button-cancel-propose-${interpretationId}`}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function InterpretationCard({
  interp,
  sourceId,
  pillarSlug,
  pillarName,
  myUserId,
  myRole,
}: {
  interp: Interpretation;
  sourceId: number;
  pillarSlug: string;
  pillarName: string;
  myUserId: number | undefined;
  myRole: "steward" | "contributor" | "advisor" | "viewer" | null;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [showThread, setShowThread] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [pendingTransition, setPendingTransition] = useState<
    null | Interpretation["status"]
  >(null);
  const [note, setNote] = useState("");

  const transition = useMutation({
    mutationFn: (vars: { status: Interpretation["status"]; note?: string }) =>
      fetchJson(`/api/faculty/interpretations/${interp.id}/transition`, {
        method: "POST",
        body: JSON.stringify({
          status: vars.status,
          ...(vars.note ? { note: vars.note } : {}),
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["faculty-interpretations", sourceId],
      });
      qc.invalidateQueries({ queryKey: ["faculty-inbox", pillarSlug] });
      qc.invalidateQueries({ queryKey: ["interp-versions", interp.id] });
      setPendingTransition(null);
      setNote("");
    },
  });

  function startTransition(status: Interpretation["status"]) {
    setPendingTransition(status);
    setNote("");
  }
  function confirmTransition() {
    if (pendingTransition)
      transition.mutate({
        status: pendingTransition,
        note: note.trim() || undefined,
      });
  }

  const isAuthor = interp.authorId != null && interp.authorId === myUserId;
  const canEdit =
    interp.status === "proposed" && (isAuthor || myRole === "steward");
  const canApprove = myRole === "steward" && interp.status === "proposed";
  const canArchive =
    myRole === "steward" &&
    (interp.status === "approved" || interp.status === "proposed");
  const canReopen = myRole === "steward" && interp.status === "archived";

  if (editing) {
    return (
      <InterpretationEditor
        sourceId={sourceId}
        interpretationId={interp.id}
        initial={interp}
        onDone={() => setEditing(false)}
        pillarSlug={pillarSlug}
      />
    );
  }

  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-[#E8DDD0] bg-white shadow-[0_4px_24px_-6px_rgba(87,32,32,0.05),0_1px_4px_-1px_rgba(87,32,32,0.03)]"
      data-testid={`interp-card-${interp.id}`}
    >
      <div
        className="absolute bottom-0 left-0 top-0 w-1.5"
        style={{ backgroundColor: INTERP_STATUS_COLOR[interp.status] }}
        aria-hidden="true"
      />
      <div className="py-6 pl-7 pr-5 sm:py-7 sm:pl-9 sm:pr-7">
        <div className="mb-6 flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
            <InterpretationStatusBadge status={interp.status} />
            <span className="text-sm leading-snug text-[#8a6a5a]">
              {INTERP_STATUS_MEANING[interp.status]}
            </span>
          </div>
          <div className="shrink-0 whitespace-nowrap text-xs font-medium text-[#8a6a5a]">
            {interp.origin === "palonur_ai"
              ? "Created by AI"
              : (interp.authorName ??
                interp.authorEmail ??
                "Faculty draft")}{" "}
            · {new Date(interp.updatedAt).toLocaleDateString()}
            {interp.version > 1 && ` · v${interp.version}`}
          </div>
        </div>
        {interp.origin === "palonur_ai" && (
          <p
            className="mb-5 rounded-lg border border-[#E7D9AE] bg-[#F6EFD9] px-3 py-2 text-xs leading-relaxed text-[#6b5a3a]"
            data-testid={`palonur-draft-attribution-${interp.id}`}
          >
            <strong>AI first draft.</strong> This was not written by a
            steward. It stays private until a steward reviews, edits if needed,
            and approves it as the governed interpretation.
            {interp.status === "approved" &&
              " This version is a steward-approved interpretation, not a claim that the steward typed the first draft."}
          </p>
        )}

        <h3
          className="mb-6 font-serif text-2xl leading-snug text-[#572020]"
          data-testid="text-interp-answer"
        >
          {interp.answer}
        </h3>

        <div className="space-y-5">
          <div>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.15em] text-[#8a6a5a]">
              Interpretation
            </p>
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-[#572020]">
              {interp.interpretation}
            </p>
          </div>
          {(interp.notProven || interp.action) && (
            <div className="grid grid-cols-1 gap-6 border-t border-[#E8DDD0] pt-5 md:grid-cols-2">
              {interp.notProven && (
                <div>
                  <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.15em] text-[#8a6a5a]">
                    What the paper does NOT prove
                  </p>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-[#572020]">
                    {interp.notProven}
                  </p>
                </div>
              )}
              {interp.action && (
                <div>
                  <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.15em] text-[#8a6a5a]">
                    Recommended action
                  </p>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-[#572020]">
                    {interp.action}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {interp.tags.length > 0 && (
          <div className="mt-6 flex flex-wrap gap-2">
            {interp.tags.map((t) => (
              <span
                key={t}
                className="rounded border border-[#E8DDD0] bg-[#FBF7F0] px-2.5 py-1 text-xs font-medium text-[#8a6a5a]"
              >
                {t}
              </span>
            ))}
          </div>
        )}

        <div className="mt-7 border-t border-[#E8DDD0] pt-5">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <div className="flex flex-wrap items-center gap-2.5">
              {canEdit && (
                <button
                  onClick={() => setEditing(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#E8DDD0] bg-[#F9F5EE] px-4 py-2 text-sm font-medium text-[#572020] transition-colors hover:bg-[#F4ECDD]"
                  data-testid={`button-edit-interp-${interp.id}`}
                >
                  <IconPencil className="h-4 w-4 text-[#8a6a5a]" />
                  Edit
                </button>
              )}
              {canApprove && (
                <button
                  onClick={() => startTransition("approved")}
                  disabled={transition.isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#3a9a4f] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#2f8241] disabled:opacity-50"
                  data-testid={`button-approve-${interp.id}`}
                >
                  <IconCheck className="h-4 w-4" />
                  Approve
                </button>
              )}
              {canArchive && (
                <button
                  onClick={() => startTransition("archived")}
                  disabled={transition.isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#E8DDD0] bg-[#F9F5EE] px-4 py-2 text-sm font-medium text-[#572020] transition-colors hover:bg-[#F4ECDD] disabled:opacity-50"
                  data-testid={`button-archive-${interp.id}`}
                >
                  {interp.status === "approved" ? (
                    <IconArchive className="h-4 w-4 text-[#8a6a5a]" />
                  ) : (
                    <IconSendBack className="h-4 w-4 text-[#8a6a5a]" />
                  )}
                  {interp.status === "approved" ? "Retract" : "Send back"}
                </button>
              )}
              {canReopen && (
                <button
                  onClick={() => startTransition("proposed")}
                  disabled={transition.isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#E8DDD0] bg-[#F9F5EE] px-4 py-2 text-sm font-medium text-[#572020] transition-colors hover:bg-[#F4ECDD] disabled:opacity-50"
                  data-testid={`button-reopen-${interp.id}`}
                >
                  <IconReopen className="h-4 w-4 text-[#8a6a5a]" />
                  Re-open
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-medium text-[#8a6a5a]">
              <button
                onClick={() => setShowHistory((v) => !v)}
                className="inline-flex items-center gap-1.5 transition-colors hover:text-[#572020]"
                data-testid={`button-toggle-history-${interp.id}`}
              >
                <IconHistory className="h-3.5 w-3.5" />
                {showHistory ? "Hide history" : "History"}
              </button>
              <button
                onClick={() => setShowThread((v) => !v)}
                className="inline-flex items-center gap-1.5 transition-colors hover:text-[#572020]"
                data-testid={`button-toggle-thread-${interp.id}`}
              >
                <IconDiscuss className="h-3.5 w-3.5" />
                {showThread ? "Hide team discussion" : "Discuss with your team"}
              </button>
            </div>
          </div>

          {interp.status === "approved" && (
            <div className="mt-3">
              <ProposeAdoptInline
                interpretationId={interp.id}
                sourcePillarSlug={pillarSlug}
              />
            </div>
          )}
        </div>
        {pendingTransition && (
          <div
            className="mt-3 border border-[#E8DDD0] rounded-lg p-3 bg-[#F9F5EE]"
            data-testid="transition-confirm"
          >
            <p className="text-xs text-[#572020] mb-2">
              Why are you{" "}
              {pendingTransition === "approved"
                ? "approving"
                : pendingTransition === "archived"
                  ? interp.status === "approved"
                    ? "retracting"
                    : "sending back"
                  : "re-opening"}{" "}
              this interpretation? (optional, becomes part of the permanent
              audit history)
            </p>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="e.g. New 2025 meta-analysis supersedes finding"
              className="w-full bg-white border border-[#E8DDD0] rounded px-3 py-2 text-xs"
              data-testid="textarea-transition-note"
            />
            <div className="flex gap-2 mt-2">
              <button
                onClick={confirmTransition}
                disabled={transition.isPending}
                className="text-xs bg-[#8C1515] text-white px-3 py-1 rounded font-medium hover:bg-[#a01a1a] disabled:opacity-50"
                data-testid="button-confirm-transition"
              >
                {transition.isPending ? "Saving…" : "Confirm"}
              </button>
              <button
                onClick={() => {
                  setPendingTransition(null);
                  setNote("");
                }}
                className="text-xs text-[#8a6a5a] hover:text-[#572020] px-3 py-1"
                data-testid="button-cancel-transition"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {transition.error && (
          <p className="text-xs text-[#E8352A] mt-2">
            {(transition.error as Error).message}
          </p>
        )}
        {showHistory && (
          <div className="mt-4 border-t border-[#E8DDD0] pt-4">
            <p className="text-xs text-[#8a6a5a] mb-3">Version history</p>
            <InterpretationVersionHistory interpretationId={interp.id} />
          </div>
        )}
        {showThread && (
          <InterpretationDiscussion
            interpretationId={interp.id}
            pillarName={pillarName}
          />
        )}
      </div>
    </div>
  );
}

function InterpretationsTab({
  sourceId,
  pillarSlug,
}: {
  sourceId: number;
  pillarSlug: string;
}) {
  const { data: me } = useMe();
  const [composing, setComposing] = useState(false);

  const { data, isLoading, error } = useQuery<InterpretationsResponse>({
    queryKey: ["faculty-interpretations", sourceId],
    queryFn: () =>
      fetchJson(`/api/faculty/sources/${sourceId}/interpretations`),
  });

  if (isLoading) return <p className="text-[#8a6a5a]">Loading…</p>;
  if (error)
    return <p className="text-[#E8352A]">{(error as Error).message}</p>;
  if (!data) return null;

  const role = data.role;
  const canCreate =
    role === "steward" || role === "contributor" || role === "advisor";
  const canInvite = role === "steward";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-serif text-2xl text-[#572020]">
            Faculty interpretations
          </h2>
          <p className="mt-1 max-w-xl text-sm text-[#8a6a5a] leading-relaxed">
            This is where your team turns the paper into a trustworthy answer.
            Draft a reading, discuss it together, and once a steward approves
            it, it goes live — The AI can cite it when it answers readers.
          </p>
        </div>
        {canCreate && !composing && (
          <button
            onClick={() => setComposing(true)}
            className="inline-flex shrink-0 items-center gap-2 rounded-full bg-[#8C1515] px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[#a01a1a]"
            data-testid="button-new-interpretation"
          >
            <IconPlus className="h-4 w-4" />
            New interpretation
          </button>
        )}
      </div>
      {canInvite && (
        <InviteColleagueInline
          slug={pillarSlug}
          pillarId={data.pillar.id}
          pillarName={data.pillar.name}
        />
      )}
      {composing && (
        <InterpretationEditor
          sourceId={sourceId}
          onDone={() => setComposing(false)}
          pillarSlug={pillarSlug}
        />
      )}
      {data.interpretations.length === 0 && !composing && (
        <div className="rounded-2xl border border-dashed border-[#E8DDD0] bg-[#FBF7F0] p-8 text-center">
          <p className="font-serif text-lg text-[#572020]">
            No interpretations yet
          </p>
          <p className="mt-1 text-sm text-[#8a6a5a]">
            {canCreate
              ? "Be the first to draft a reading of this paper for your team to discuss."
              : "Once your team drafts a reading of this paper, it'll appear here."}
          </p>
          {canCreate && (
            <button
              onClick={() => setComposing(true)}
              className="mt-4 inline-flex items-center gap-2 rounded-full bg-[#8C1515] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#a01a1a]"
              data-testid="button-new-interpretation-empty"
            >
              <IconPlus className="h-4 w-4" />
              Draft the first interpretation
            </button>
          )}
        </div>
      )}
      <div className="space-y-4">
        {data.interpretations.map((i) => (
          <InterpretationCard
            key={i.id}
            interp={i}
            sourceId={sourceId}
            pillarSlug={pillarSlug}
            pillarName={data.pillar.name}
            myUserId={me?.user.id}
            myRole={role}
          />
        ))}
      </div>
    </div>
  );
}

// ---------- Steward inbox ----------

interface RubricVerdictEntry {
  checkId: number;
  name: string;
  verdict: "pass" | "flag" | "pending";
  rationale: string | null;
}

interface RubricCheck {
  id: number;
  name: string;
  instruction: string;
}

interface InboxItem {
  id: number;
  sourceId: number;
  sourceTitle: string;
  sourceAuthors: string | null;
  sourceYear: number | null;
  answer: string;
  version: number;
  authorName: string | null;
  authorEmail: string | null;
  createdAt: string;
  updatedAt: string;
  rubric?: RubricVerdictEntry[];
}

/**
 * Steward-editable rubric checks for the pillar. Advisory only — every
 * pending draft is scored against these before the steward opens it, but
 * a flag never blocks approval.
 */
function RubricChecksPanel({
  slug,
  checks,
  isSteward,
}: {
  slug: string;
  checks: RubricCheck[];
  isSteward: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["faculty-inbox", slug] });

  const create = useMutation({
    mutationFn: () =>
      fetchJson(`/api/faculty/pillars/${slug}/rubric-checks`, {
        method: "POST",
        body: JSON.stringify({ name, instruction }),
      }),
    onSuccess: () => {
      setName("");
      setInstruction("");
      invalidate();
    },
  });
  const update = useMutation({
    mutationFn: (vars: { id: number }) =>
      fetchJson(`/api/faculty/pillars/${slug}/rubric-checks/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, instruction }),
      }),
    onSuccess: () => {
      setEditingId(null);
      setName("");
      setInstruction("");
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) =>
      fetchJson(`/api/faculty/pillars/${slug}/rubric-checks/${id}`, {
        method: "DELETE",
      }),
    onSuccess: invalidate,
  });

  function startEdit(c: RubricCheck) {
    setEditingId(c.id);
    setName(c.name);
    setInstruction(c.instruction);
  }
  function cancelEdit() {
    setEditingId(null);
    setName("");
    setInstruction("");
  }

  return (
    <div className="mb-8 border border-[#E8DDD0] rounded-xl p-5 bg-[#FDFBF7]">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between text-left"
        data-testid="button-rubric-toggle"
      >
        <div>
          <p className="text-[10px] tracking-[0.25em] text-[#8C1515] uppercase">
            Rubric checks
          </p>
          <p className="text-sm text-[#8a6a5a] mt-1">
            {checks.length === 0
              ? "Turn recurring feedback into automatic draft checks."
              : `${checks.length} check${checks.length === 1 ? "" : "s"} — every pending draft is scored automatically. Advisory only; you stay the approver.`}
          </p>
        </div>
        <span className="text-[#8a6a5a] text-sm shrink-0 ml-3">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <div className="mt-4 space-y-3">
          {checks.map((c) => (
            <div
              key={c.id}
              className="border border-[#E8DDD0] rounded-lg p-3 bg-white"
              data-testid={`rubric-check-${c.id}`}
            >
              {editingId === c.id ? (
                <div className="space-y-2">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full border border-[#E8DDD0] rounded px-3 py-2 text-xs"
                    data-testid="input-rubric-edit-name"
                  />
                  <textarea
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    rows={2}
                    className="w-full border border-[#E8DDD0] rounded px-3 py-2 text-xs"
                    data-testid="textarea-rubric-edit-instruction"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => update.mutate({ id: c.id })}
                      disabled={
                        update.isPending || !name.trim() || !instruction.trim()
                      }
                      className="text-xs bg-[#8C1515] text-white px-3 py-1 rounded font-medium disabled:opacity-50"
                      data-testid="button-rubric-save"
                    >
                      {update.isPending ? "Saving…" : "Save"}
                    </button>
                    <button
                      onClick={cancelEdit}
                      className="text-xs text-[#8a6a5a] px-3 py-1"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium text-[#572020]">
                      {c.name}
                    </p>
                    <p className="text-xs text-[#8a6a5a] mt-1">
                      {c.instruction}
                    </p>
                  </div>
                  {isSteward && (
                    <div className="flex gap-2 shrink-0">
                      <button
                        onClick={() => startEdit(c)}
                        className="text-xs text-[#8a6a5a] hover:text-[#572020]"
                        data-testid={`button-rubric-edit-${c.id}`}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete the "${c.name}" check? Existing drafts will no longer be scored against it.`,
                            )
                          )
                            remove.mutate(c.id);
                        }}
                        className="text-xs text-[#8a6a5a] hover:text-[#E8352A]"
                        data-testid={`button-rubric-delete-${c.id}`}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {isSteward && editingId === null && (
            <div className="border border-dashed border-[#E8DDD0] rounded-lg p-3">
              <p className="text-xs text-[#572020] mb-2">
                New check — name it, then phrase it like the feedback you keep
                re-typing:
              </p>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Age range stated"
                className="w-full border border-[#E8DDD0] rounded px-3 py-2 text-xs mb-2"
                data-testid="input-rubric-name"
              />
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                rows={2}
                placeholder="e.g. The draft must state the study population's age range."
                className="w-full border border-[#E8DDD0] rounded px-3 py-2 text-xs mb-2"
                data-testid="textarea-rubric-instruction"
              />
              <button
                onClick={() => create.mutate()}
                disabled={
                  create.isPending || !name.trim() || !instruction.trim()
                }
                className="text-xs bg-[#8C1515] text-white px-3 py-1 rounded font-medium disabled:opacity-50"
                data-testid="button-rubric-add"
              >
                {create.isPending ? "Adding…" : "Add check"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StewardInbox() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery<{
    pillar: { slug: string; name: string };
    checks?: RubricCheck[];
    pending: InboxItem[];
  }>({
    queryKey: ["faculty-inbox", slug],
    queryFn: () => fetchJson(`/api/faculty/pillars/${slug}/inbox`),
    // Rubric verdicts are evaluated lazily server-side (a few drafts per
    // read); keep polling while any badge is still pending.
    refetchInterval: (query) =>
      query.state.data?.pending.some((p) =>
        p.rubric?.some((r) => r.verdict === "pending"),
      )
        ? 8000
        : false,
  });

  const [pending, setPending] = useState<null | {
    id: number;
    status: "approved" | "archived";
  }>(null);
  const [note, setNote] = useState("");

  const transition = useMutation({
    mutationFn: (vars: {
      id: number;
      status: "approved" | "archived";
      note?: string;
    }) =>
      fetchJson(`/api/faculty/interpretations/${vars.id}/transition`, {
        method: "POST",
        body: JSON.stringify({
          status: vars.status,
          ...(vars.note ? { note: vars.note } : {}),
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["faculty-inbox", slug] });
      setPending(null);
      setNote("");
    },
  });

  function startQuickTransition(id: number, status: "approved" | "archived") {
    setPending({ id, status });
    setNote("");
  }
  function confirmQuickTransition() {
    if (!pending) return;
    if (pending.status === "archived" && !note.trim()) {
      // Send-back without a reason isn't useful audit history.
      return;
    }
    transition.mutate({
      id: pending.id,
      status: pending.status,
      note: note.trim() || undefined,
    });
  }

  if (isLoading)
    return (
      <PortalShell>
        <p className="text-[#8a6a5a]">Loading…</p>
      </PortalShell>
    );
  if (error)
    return (
      <PortalShell>
        <p className="text-[#E8352A]" data-testid="text-inbox-error">
          {(error as Error).message}
        </p>
      </PortalShell>
    );
  if (!data) return null;

  return (
    <PortalShell>
      <Link
        href={`/pillars/${slug}`}
        className="text-sm text-[#8a6a5a] hover:text-[#572020]"
      >
        ← {data.pillar.name}
      </Link>
      <div className="mt-4 mb-8">
        <p className="text-[10px] tracking-[0.25em] text-[#8C1515] uppercase mb-2">
          Steward · review queue
        </p>
        <h1 className="font-serif text-3xl font-medium">Pending review</h1>
        <p className="text-sm text-[#8a6a5a] mt-2">
          {data.pending.length === 0
            ? "Nothing waiting on you. Nice."
            : `${data.pending.length} interpretation${data.pending.length === 1 ? "" : "s"} awaiting your call. Oldest first.`}
        </p>
      </div>
      <RubricChecksPanel
        slug={slug!}
        checks={data.checks ?? []}
        isSteward={true}
      />
      <div className="space-y-3">
        {data.pending.map((i) => {
          const flagged = i.rubric?.some((r) => r.verdict === "flag") ?? false;
          return (
            <div
              key={i.id}
              className={`border rounded-xl p-5 ${flagged ? "border-[#D9822B] bg-[#FDF6EE]" : "border-[#E8DDD0]"}`}
              data-testid={`inbox-row-${i.id}`}
            >
              <div className="flex items-baseline justify-between gap-3 mb-2">
                <Link
                  href={`/pillars/${slug}/sources/${i.sourceId}`}
                  className="text-xs text-[#8C1515] hover:underline truncate"
                >
                  {i.sourceTitle}
                </Link>
                <span className="text-xs text-[#8a6a5a] shrink-0">
                  {new Date(i.createdAt).toLocaleDateString()}
                </span>
              </div>
              <p className="font-serif text-base text-[#572020] mb-2">
                {i.answer}
              </p>
              <p className="text-xs text-[#8a6a5a] mb-3">
                proposed by {i.authorName ?? i.authorEmail ?? "anonymous"}
              </p>
              {(i.rubric?.length ?? 0) > 0 && (
                <div
                  className="flex flex-wrap gap-1.5 mb-3"
                  data-testid={`inbox-rubric-${i.id}`}
                >
                  {i.rubric!.map((r) => (
                    <span
                      key={r.checkId}
                      title={r.rationale ?? undefined}
                      className={`text-[10px] px-2 py-0.5 rounded-full border ${
                        r.verdict === "flag"
                          ? "border-[#D9822B] bg-[#FBEBD9] text-[#8a4a0b]"
                          : r.verdict === "pass"
                            ? "border-[#bcd9c2] bg-[#eef7f0] text-[#2c6e3c]"
                            : "border-[#E8DDD0] bg-[#F9F5EE] text-[#8a6a5a]"
                      }`}
                      data-testid={`rubric-badge-${i.id}-${r.checkId}`}
                    >
                      {r.verdict === "flag"
                        ? "⚑ "
                        : r.verdict === "pass"
                          ? "✓ "
                          : "… "}
                      {r.name}
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => startQuickTransition(i.id, "approved")}
                  disabled={transition.isPending}
                  className="bg-[#3a9a4f] text-white px-3 py-1 rounded text-xs font-medium hover:bg-[#48b35e] disabled:opacity-50"
                  data-testid={`button-inbox-approve-${i.id}`}
                >
                  Approve
                </button>
                <button
                  onClick={() => startQuickTransition(i.id, "archived")}
                  disabled={transition.isPending}
                  className="border border-[#E8DDD0] hover:border-[#E8352A] px-3 py-1 rounded text-xs"
                  data-testid={`button-inbox-sendback-${i.id}`}
                >
                  Send back
                </button>
                <Link
                  href={`/pillars/${slug}/sources/${i.sourceId}`}
                  className="text-xs text-[#8a6a5a] hover:text-[#572020] px-3 py-1"
                >
                  Open source →
                </Link>
              </div>
              {pending?.id === i.id && (
                <div
                  className="mt-3 border border-[#E8DDD0] rounded-lg p-3 bg-[#F9F5EE]"
                  data-testid="inbox-transition-confirm"
                >
                  <p className="text-xs text-[#572020] mb-2">
                    {pending.status === "approved"
                      ? "Approval note (optional, becomes part of the audit history):"
                      : "Why are you sending this back? (required — the author needs to know what to change)"}
                  </p>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                    placeholder={
                      pending.status === "approved"
                        ? "e.g. Aligns with the 2024 Stanford position paper"
                        : "e.g. Needs the dose-response caveat from §3"
                    }
                    className="w-full bg-white border border-[#E8DDD0] rounded px-3 py-2 text-xs"
                    data-testid="textarea-inbox-note"
                  />
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={confirmQuickTransition}
                      disabled={
                        transition.isPending ||
                        (pending.status === "archived" && !note.trim())
                      }
                      className="text-xs bg-[#8C1515] text-white px-3 py-1 rounded font-medium hover:bg-[#a01a1a] disabled:opacity-50"
                      data-testid="button-inbox-confirm"
                    >
                      {transition.isPending ? "Saving…" : "Confirm"}
                    </button>
                    <button
                      onClick={() => {
                        setPending(null);
                        setNote("");
                      }}
                      className="text-xs text-[#8a6a5a] hover:text-[#572020] px-3 py-1"
                      data-testid="button-inbox-cancel"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </PortalShell>
  );
}

function AcceptInvite() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const { isSignedIn } = useUser();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();

  const { data: invite, isLoading } = useQuery<{
    email: string;
    pillarName: string;
    pillarSlug: string;
    role: string;
    status: string;
    expired: boolean;
  }>({
    queryKey: ["faculty-invite", token],
    queryFn: () => fetchJson(`/api/faculty/invitations/${token}`),
  });

  const accept = useMutation({
    mutationFn: () =>
      fetchJson<{ pillar: { slug: string } | null }>(
        `/api/faculty/invitations/${token}/accept`,
        { method: "POST" },
      ),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["faculty-me"] });
      setLocation(r.pillar ? `/pillars/${r.pillar.slug}` : "/dashboard");
    },
  });

  if (isLoading)
    return (
      <div className="min-h-screen bg-[#FBF7F0] text-[#572020] flex items-center justify-center">
        Loading…
      </div>
    );

  if (!invite)
    return (
      <div className="min-h-screen bg-[#FBF7F0] text-[#572020] flex items-center justify-center px-6 text-center">
        <div>
          <h1 className="font-serif text-3xl mb-3">Invitation not found</h1>
          <p className="text-[#8a6a5a]">This invite link is invalid.</p>
        </div>
      </div>
    );

  return (
    <div className="min-h-screen bg-[#FBF7F0] text-[#572020] flex items-center justify-center px-6">
      <div className="max-w-md text-center">
        <p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-4">
          Stanford Lifestyle Medicine · Invitation
        </p>
        <h1 className="font-serif text-3xl mb-3">
          You're invited to {invite.pillarName}
        </h1>
        <p className="text-[#8a6a5a] mb-8">
          {invite.email} · Role: {invite.role}
        </p>

        {invite.status !== "pending" || invite.expired ? (
          <p className="text-[#E8352A]" data-testid="text-invite-unavailable">
            {invite.expired
              ? "This invitation has expired."
              : `Invitation already ${invite.status}.`}
          </p>
        ) : isSignedIn ? (
          <button
            onClick={() => accept.mutate()}
            disabled={accept.isPending}
            className="bg-[#8C1515] text-white px-6 py-3 rounded-lg font-medium hover:bg-[#a01a1a] disabled:opacity-50"
            data-testid="button-accept-invite"
          >
            {accept.isPending ? "Accepting…" : "Accept invitation"}
          </button>
        ) : (
          <>
            <p className="text-[#8a6a5a] mb-4">
              Sign in with <strong>{invite.email}</strong> to accept.
            </p>
            <Link
              href={`/sign-in?redirect_url=${encodeURIComponent(`${basePath}/invite/${token}`)}`}
              className="inline-block bg-[#8C1515] text-white px-6 py-3 rounded-lg font-medium hover:bg-[#a01a1a]"
              data-testid="link-sign-in-to-accept"
            >
              Sign in to accept
            </Link>
          </>
        )}
        {accept.error && (
          <p className="mt-4 text-[#E8352A] text-sm">
            {(accept.error as Error).message}
          </p>
        )}
      </div>
    </div>
  );
}

// ---------- First-login welcome story ----------
// A paced, full-screen narrative shown once to a new Stanford Lifestyle Medicine
// faculty member: the program's purpose, the value of sharing evidence clearly,
// and how the Faculty workspace works in practice.

interface WelcomeChapter {
  eyebrow: string;
  title: string;
  body: string;
  illustration: string;
  /** Large photographic-style hero image (16:9, in public/illustrations). */
  image: string;
  takeaway: string;
}

const WELCOME_CHAPTERS: WelcomeChapter[] = [
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
];

const WELCOME_HOW_IT_WORKS: Array<{
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
];

function Welcome() {
  const { data: me, isLoading } = useMe();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [step, setStep] = useState(0);

  const totalSteps = WELCOME_CHAPTERS.length + 1; // chapters + "how it works"
  const isLastStep = step === totalSteps - 1;

  const complete = useMutation({
    mutationFn: () =>
      fetchJson("/api/faculty/onboarding/complete", { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["faculty-me"] });
      navigate("/dashboard");
    },
  });

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [step]);

  // Already onboarded (e.g. revisiting the URL) → straight to the portal.
  if (!isLoading && me && me.onboarded) {
    return <Redirect to="/dashboard" />;
  }
  if (!isLoading && me && me.awaitingInvitation) {
    return <Redirect to="/awaiting-invite" />;
  }

  const finish = () => complete.mutate();

  return (
    <div className="min-h-screen bg-white text-[#2E2D29] flex flex-col font-sans">
      {/* Top bar: brand + skip */}
      <header className="border-b border-[#D5D0C8] px-6 py-4 flex items-center justify-between">
        <img
          src={FACULTY_LOGO_SRC}
          alt="Stanford Lifestyle Medicine"
          className="h-12 w-auto"
        />
        <button
          onClick={finish}
          disabled={complete.isPending}
          className="text-sm font-medium text-[#5F574F] hover:text-[#8C1515] transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8C1515] focus-visible:ring-offset-2"
          data-testid="button-skip-welcome"
        >
          Skip intro
        </button>
      </header>

      <main className="flex-1 flex items-center justify-center px-6 py-10">
        <div key={step} className="w-full max-w-4xl welcome-fade">
          {step < WELCOME_CHAPTERS.length ? (
            <div>
              {/* Large editorial hero image with a restrained Stanford treatment. */}
              <div className="mb-8 overflow-hidden border border-[#D5D0C8] shadow-[0_18px_50px_-24px_rgba(46,45,41,0.18)]">
                <img
                  src={illuJpg(WELCOME_CHAPTERS[step].image)}
                  alt=""
                  aria-hidden
                  loading="eager"
                  className="w-full aspect-[21/9] object-cover"
                />
              </div>
              <p className="text-[11px] font-semibold tracking-[0.22em] text-[#8C1515] uppercase mb-5 text-center">
                {WELCOME_CHAPTERS[step].eyebrow}
              </p>
              <h1 className="font-serif text-4xl md:text-5xl font-semibold leading-[1.12] mb-6 text-center text-[#2E2D29]">
                {WELCOME_CHAPTERS[step].title}
              </h1>
              <p className="text-lg text-[#5F574F] leading-relaxed max-w-xl mx-auto text-center">
                {WELCOME_CHAPTERS[step].body}
              </p>
              <p className="mt-6 max-w-xl mx-auto text-center text-base font-semibold text-[#8C1515] bg-[#F8F2F2] border border-[#D5D0C8] px-5 py-3">
                {WELCOME_CHAPTERS[step].takeaway}
              </p>
            </div>
          ) : (
            <div>
              <p className="text-[11px] font-semibold tracking-[0.22em] text-[#8C1515] uppercase mb-5">
                How it works
              </p>
              <h1 className="font-serif text-4xl md:text-5xl font-semibold leading-[1.12] mb-3 text-[#2E2D29]">
                Your Faculty workspace, in four moves.
              </h1>
              <p className="text-base text-[#5F574F] leading-relaxed mb-8 max-w-xl">
                Here is the whole loop. The Stanford Lifestyle Medicine Program
                takes care of the organizing so you can focus on the science.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                {WELCOME_HOW_IT_WORKS.map((s) => (
                  <div
                    key={s.step}
                    className="border border-[#D5D0C8] bg-white p-5"
                  >
                    <div className="flex items-center gap-3 mb-3">
                      <div className="flex-none inline-flex h-14 w-14 items-center justify-center bg-[#F8F2F2] border border-[#D5D0C8]">
                        <img
                          src={illu(s.illustration)}
                          alt=""
                          aria-hidden
                          loading="lazy"
                          className="h-10 w-10 object-contain"
                        />
                      </div>
                      <div className="font-serif text-2xl font-semibold text-[#8C1515]">
                        {s.step}
                      </div>
                    </div>
                    <div className="font-semibold text-[#2E2D29] mb-1">
                      {s.title}
                    </div>
                    <p className="text-sm text-[#5F574F] leading-relaxed">
                      {s.body}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Footer: progress dots + nav */}
      <footer className="px-6 py-8">
        <div className="max-w-2xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-2" aria-hidden>
            {Array.from({ length: totalSteps }).map((_, i) => (
              <span
                key={i}
                className={`h-1.5 transition-all ${
                  i === step
                    ? "w-6 bg-[#8C1515]"
                    : i < step
                      ? "w-1.5 bg-[#8C1515]/40"
                      : "w-1.5 bg-[#E8DDD0]"
                }`}
              />
            ))}
          </div>
          <div className="flex items-center gap-3">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                className="text-sm font-medium text-[#5F574F] hover:text-[#8C1515] transition px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8C1515] focus-visible:ring-offset-2"
                data-testid="button-welcome-back"
              >
                Back
              </button>
            )}
            {isLastStep ? (
              <button
                onClick={finish}
                disabled={complete.isPending}
                className="bg-[#8C1515] text-white px-6 py-3 font-semibold hover:bg-[#6F1111] transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8C1515] focus-visible:ring-offset-2"
                data-testid="button-enter-portal"
              >
                {complete.isPending ? "Entering…" : "Enter your portal"}
              </button>
            ) : (
              <button
                onClick={() => setStep((s) => Math.min(totalSteps - 1, s + 1))}
                className="bg-[#8C1515] text-white px-6 py-3 font-semibold hover:bg-[#6F1111] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8C1515] focus-visible:ring-offset-2"
                data-testid="button-welcome-next"
              >
                Continue
              </button>
            )}
          </div>
        </div>
        {complete.isError && (
          <p className="max-w-2xl mx-auto mt-3 text-sm text-[#E8352A] text-right">
            {(complete.error as Error).message}
          </p>
        )}
      </footer>
    </div>
  );
}

// ---------- Frameworks (bookable, revenue-shared connective tissue) ----------

interface FrameworkItem {
  id: number;
  pillarId: number;
  ownerUserId: number | null;
  name: string;
  slug: string;
  description: string | null;
  structure: string;
  example: string | null;
  status: "draft" | "published" | "retired";
  createdAt: string;
  updatedAt: string;
  pillarName: string | null;
  pillarSlug: string | null;
  ownerName: string | null;
}

interface FrameworkBookingItem {
  id: number;
  frameworkId: number;
  ownerPillarId: number;
  ownerUserId: number | null;
  bookerPillarId: number;
  bookerUserId: number | null;
  targetType: string | null;
  targetId: number | null;
  targetTitle: string | null;
  status: "booked" | "revenue_recorded" | "settled";
  revenueCents: number | null;
  sharePct: number;
  ownerShareCents: number | null;
  note: string | null;
  createdAt: string;
  revenueRecordedAt: string | null;
  settledAt: string | null;
  updatedAt: string;
  frameworkName: string | null;
  ownerName: string | null;
  ownerPillarName: string | null;
  bookerName: string | null;
  bookerPillarName: string | null;
}

interface FrameworkBookingSummaryT {
  count: number;
  owedCents: number;
  settledCents: number;
  revenueCents: number;
}

interface FrameworkBookingsResp {
  bookings: FrameworkBookingItem[];
  summary: FrameworkBookingSummaryT;
}

interface FrameworkApplyResultT {
  ok: boolean;
  reason?: string | null;
  refused?: boolean;
  uncovered?: boolean;
  draft?: string;
  attribution?: {
    frameworkId: number;
    frameworkName: string;
    ownerName: string | null;
    pillarName: string | null;
    pillarSlug: string | null;
  };
  provenance?: unknown[];
  citationVerification?: { status?: string } | null;
  voiceVerification?: { status?: string } | null;
}

function fwUsd(cents: number | null | undefined): string {
  return `$${((cents ?? 0) / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const TARGET_LABEL: Record<string, string> = {
  interpretation: "Interpretation",
  newsletter_post: "Newsletter post",
  communication_offer: "Article review",
  article: "Article",
};

/**
 * Reusable "apply a colleague's framework" panel. Drop it under any draft
 * editor: it picks a published framework, AI-rewrites the current draft to that
 * framework (grounded in the owner's approved content, attributed to the owner),
 * lets the steward adopt the rewrite, and books the use into the ledger.
 */
function FrameworkApplyPanel({
  kind,
  draft,
  onUseDraft,
  booking,
}: {
  kind: "answer" | "article";
  draft: string;
  onUseDraft?: (text: string) => void;
  booking?: {
    bookerPillarId: number;
    targetType?:
      | "interpretation"
      | "newsletter_post"
      | "communication_offer"
      | "article";
    targetId?: number;
    targetTitle?: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | "">("");
  const [result, setResult] = useState<FrameworkApplyResultT | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [booked, setBooked] = useState(false);

  const publishedQuery = useQuery<{ frameworks: FrameworkItem[] }>({
    queryKey: ["faculty-frameworks-published"],
    queryFn: () => fetchJson("/api/faculty/frameworks/published"),
    enabled: open,
  });

  const apply = useMutation({
    mutationFn: (id: number) =>
      fetchJson<FrameworkApplyResultT>(`/api/faculty/frameworks/${id}/apply`, {
        method: "POST",
        body: JSON.stringify({ draft, kind }),
      }),
    onMutate: () => {
      setResult(null);
      setMsg(null);
      setBooked(false);
    },
    onSuccess: (r) => {
      setResult(r);
      if (!r.ok && r.reason === "ai_unavailable") {
        setMsg("The rewrite assistant is not configured right now.");
      }
    },
    onError: (e: Error) => setMsg(`Error: ${e.message}`),
  });

  const bookM = useMutation({
    mutationFn: (id: number) =>
      fetchJson(`/api/faculty/frameworks/bookings`, {
        method: "POST",
        body: JSON.stringify({
          frameworkId: id,
          bookerPillarId: booking!.bookerPillarId,
          targetType: booking?.targetType,
          targetId: booking?.targetId,
          targetTitle: booking?.targetTitle,
        }),
      }),
    onSuccess: () => {
      setBooked(true);
      setMsg("Booked — recorded in the revenue-share ledger.");
    },
    onError: (e: Error) => setMsg(`Booking failed: ${e.message}`),
  });

  // The picker intentionally offers ONLY Allison Kluger's communication-pillar
  // framework — dev/test junk pillars publish fixture frameworks, and the
  // product decision is that stewards apply Allison's framework specifically.
  const frameworks = (publishedQuery.data?.frameworks ?? []).filter(
    (f) => f.pillarSlug === "communication",
  );
  const canGenerate =
    selectedId !== "" && draft.trim().length > 0 && !apply.isPending;

  return (
    <div
      className="mt-4 border border-[#E8DDD0] rounded-lg bg-[#F9F5EE]"
      data-testid="framework-apply-panel"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-2 text-sm text-[#572020]"
        data-testid="button-toggle-framework-apply"
      >
        <span className="font-medium">✦ Apply a colleague's framework</span>
        <span className="text-[#8a6a5a]">{open ? "–" : "+"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3">
          <p className="text-[11px] text-[#8a6a5a] leading-relaxed">
            Rewrite this {kind === "article" ? "article" : "answer"} using
            another pillar's named framework. The rewrite stays grounded in that
            owner's approved knowledge and is attributed to them; booking it
            records a deferred revenue share.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={selectedId}
              onChange={(e) =>
                setSelectedId(e.target.value ? Number(e.target.value) : "")
              }
              className="bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm flex-1 min-w-[200px]"
              data-testid="select-framework"
            >
              <option value="">
                {publishedQuery.isLoading
                  ? "Loading frameworks…"
                  : frameworks.length === 0
                    ? "No published frameworks yet"
                    : "Choose a framework…"}
              </option>
              {frameworks.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} — {f.ownerName ?? "Unknown"} ({f.pillarName ?? "?"})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => selectedId !== "" && apply.mutate(selectedId)}
              disabled={!canGenerate}
              className="bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] disabled:opacity-50"
              data-testid="button-generate-framework"
            >
              {apply.isPending ? "Rewriting…" : "Generate"}
            </button>
          </div>

          {result && result.ok && result.draft && !result.refused && (
            <div className="space-y-2" data-testid="framework-result">
              {result.attribution && (
                <p className="text-[11px] text-[#8a6a5a]">
                  Using{" "}
                  <strong className="text-[#572020]">
                    {result.attribution.ownerName ?? "the owner"}'s
                  </strong>{" "}
                  “{result.attribution.frameworkName}” framework
                  {result.attribution.pillarName
                    ? ` (${result.attribution.pillarName})`
                    : ""}
                  .
                </p>
              )}
              {result.uncovered ? (
                <p
                  className="text-xs text-[#8a6a5a] bg-white border border-[#E8DDD0] rounded-lg p-3"
                  data-testid="framework-uncovered"
                >
                  {result.draft}
                </p>
              ) : (
                <>
                  <textarea
                    readOnly
                    value={result.draft}
                    rows={8}
                    className="w-full bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm"
                    data-testid="textarea-framework-result"
                  />
                  <div className="flex items-center gap-2 flex-wrap text-[11px]">
                    {result.citationVerification?.status && (
                      <span className="text-[#8a6a5a]">
                        Citation: {result.citationVerification.status}
                      </span>
                    )}
                    {result.voiceVerification?.status && (
                      <span className="text-[#8a6a5a]">
                        Voice: {result.voiceVerification.status}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {onUseDraft && (
                      <button
                        type="button"
                        onClick={() => onUseDraft(result.draft!)}
                        className="bg-[#8C1515] text-white px-3 py-2 rounded-lg text-xs font-medium hover:bg-[#a01a1a]"
                        data-testid="button-use-framework-draft"
                      >
                        Use this draft
                      </button>
                    )}
                    {booking && selectedId !== "" && (
                      <button
                        type="button"
                        onClick={() => bookM.mutate(selectedId)}
                        disabled={bookM.isPending || booked}
                        className="border border-[#8C1515] text-[#8C1515] px-3 py-2 rounded-lg text-xs font-medium hover:bg-[#8C1515] hover:text-white disabled:opacity-50"
                        data-testid="button-book-framework"
                      >
                        {booked
                          ? "Booked ✓"
                          : bookM.isPending
                            ? "Booking…"
                            : "Book this use"}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {result && result.refused && (
            <p
              className="text-xs text-[#8a6a5a] bg-white border border-[#E8DDD0] rounded-lg p-3"
              data-testid="framework-refused"
            >
              {result.draft}
            </p>
          )}

          {msg && (
            <p
              className="text-[11px] text-[#8a6a5a]"
              data-testid="framework-msg"
            >
              {msg}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function FrameworkCreateForm({
  stewardPillars,
}: {
  stewardPillars: Array<{ id: number; name: string }>;
}) {
  const qc = useQueryClient();
  const [pillarId, setPillarId] = useState<number | "">(
    stewardPillars[0]?.id ?? "",
  );
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [structure, setStructure] = useState("");
  const [example, setExample] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      fetchJson<{ framework: FrameworkItem }>("/api/faculty/frameworks", {
        method: "POST",
        body: JSON.stringify({
          pillarId: Number(pillarId),
          name: name.trim(),
          description: description.trim() || undefined,
          structure: structure.trim(),
          example: example.trim() || undefined,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["faculty-frameworks"] });
      setName("");
      setDescription("");
      setStructure("");
      setExample("");
      setMsg("Framework created as a draft.");
    },
    onError: (e: Error) => setMsg(`Error: ${e.message}`),
  });

  const valid =
    pillarId !== "" && name.trim().length > 0 && structure.trim().length > 0;

  return (
    <div className="border border-[#E8DDD0] rounded-lg bg-white p-4 space-y-3">
      <h3 className="font-serif text-lg">New framework</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Pillar
          <select
            value={pillarId}
            onChange={(e) =>
              setPillarId(e.target.value ? Number(e.target.value) : "")
            }
            className="w-full mt-1 bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm"
            data-testid="select-framework-pillar"
          >
            {stewardPillars.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. The 3-Beat Story"
            className="w-full mt-1 bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm"
            data-testid="input-framework-name"
          />
        </label>
      </div>
      <label className="text-sm block">
        Description <span className="text-[#8a6a5a]">(optional)</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this framework is for"
          className="w-full mt-1 bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm"
          data-testid="input-framework-description"
        />
      </label>
      <label className="text-sm block">
        Structure
        <textarea
          value={structure}
          onChange={(e) => setStructure(e.target.value)}
          rows={4}
          placeholder="The steps / shape the rewrite should follow"
          className="w-full mt-1 bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm"
          data-testid="textarea-framework-structure"
        />
      </label>
      <label className="text-sm block">
        Worked example <span className="text-[#8a6a5a]">(optional)</span>
        <textarea
          value={example}
          onChange={(e) => setExample(e.target.value)}
          rows={3}
          className="w-full mt-1 bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm"
          data-testid="textarea-framework-example"
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          onClick={() => create.mutate()}
          disabled={!valid || create.isPending}
          className="bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a01a1a] disabled:opacity-50"
          data-testid="button-create-framework"
        >
          {create.isPending ? "Creating…" : "Create draft"}
        </button>
        {msg && <span className="text-xs text-[#8a6a5a]">{msg}</span>}
      </div>
    </div>
  );
}

function FrameworkRow({ framework }: { framework: FrameworkItem }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(framework.name);
  const [description, setDescription] = useState(framework.description ?? "");
  const [structure, setStructure] = useState(framework.structure);
  const [example, setExample] = useState(framework.example ?? "");
  const [msg, setMsg] = useState<string | null>(null);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["faculty-frameworks"] });

  const save = useMutation({
    mutationFn: () =>
      fetchJson(`/api/faculty/frameworks/${framework.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          structure: structure.trim(),
          example: example.trim() || null,
        }),
      }),
    onSuccess: () => {
      invalidate();
      setEditing(false);
      setMsg("Saved.");
    },
    onError: (e: Error) => setMsg(`Error: ${e.message}`),
  });

  const setStatus = useMutation({
    mutationFn: (action: "publish" | "retire") =>
      fetchJson(`/api/faculty/frameworks/${framework.id}/${action}`, {
        method: "POST",
      }),
    onSuccess: () => invalidate(),
    onError: (e: Error) => setMsg(`Error: ${e.message}`),
  });

  const statusColor =
    framework.status === "published"
      ? "text-[#1a7a4a]"
      : framework.status === "retired"
        ? "text-[#8a6a5a]"
        : "text-[#8C1515]";

  return (
    <div
      className="border border-[#E8DDD0] rounded-lg bg-white p-4 space-y-2"
      data-testid={`framework-row-${framework.id}`}
    >
      {editing ? (
        <div className="space-y-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description"
            className="w-full bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm"
          />
          <textarea
            value={structure}
            onChange={(e) => setStructure(e.target.value)}
            rows={4}
            className="w-full bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm"
          />
          <textarea
            value={example}
            onChange={(e) => setExample(e.target.value)}
            rows={3}
            placeholder="Worked example"
            className="w-full bg-white border border-[#E8DDD0] rounded-lg px-3 py-2 text-sm"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => save.mutate()}
              disabled={save.isPending}
              className="bg-[#8C1515] text-white px-3 py-2 rounded-lg text-xs font-medium hover:bg-[#a01a1a] disabled:opacity-50"
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="text-xs text-[#8a6a5a] hover:text-[#572020] px-3 py-2"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h4 className="font-serif text-base text-[#572020]">
                {framework.name}
              </h4>
              <p className="text-[11px] text-[#8a6a5a]">
                {framework.pillarName ?? "—"} ·{" "}
                <span className={statusColor}>{framework.status}</span>
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <button
                onClick={() => setEditing(true)}
                className="text-[#8a6a5a] hover:text-[#572020]"
                data-testid={`button-edit-framework-${framework.id}`}
              >
                Edit
              </button>
              {framework.status !== "published" && (
                <button
                  onClick={() => setStatus.mutate("publish")}
                  disabled={setStatus.isPending}
                  className="text-[#1a7a4a] hover:underline disabled:opacity-50"
                  data-testid={`button-publish-framework-${framework.id}`}
                >
                  Publish
                </button>
              )}
              {framework.status !== "retired" && (
                <button
                  onClick={() => setStatus.mutate("retire")}
                  disabled={setStatus.isPending}
                  className="text-[#8a6a5a] hover:underline disabled:opacity-50"
                  data-testid={`button-retire-framework-${framework.id}`}
                >
                  Retire
                </button>
              )}
            </div>
          </div>
          {framework.description && (
            <p className="text-sm text-[#572020]">{framework.description}</p>
          )}
          <p className="text-xs text-[#8a6a5a] whitespace-pre-wrap">
            {framework.structure}
          </p>
        </>
      )}
      {msg && <p className="text-[11px] text-[#8a6a5a]">{msg}</p>}
    </div>
  );
}

function BookingRevenueControl({ booking }: { booking: FrameworkBookingItem }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [dollars, setDollars] = useState(
    booking.revenueCents != null ? (booking.revenueCents / 100).toString() : "",
  );
  const record = useMutation({
    mutationFn: () =>
      fetchJson(`/api/faculty/frameworks/bookings/${booking.id}/revenue`, {
        method: "POST",
        body: JSON.stringify({
          revenueCents: Math.round(parseFloat(dollars || "0") * 100),
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["faculty-framework-bookings"] });
      setEditing(false);
    },
  });
  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="text-xs text-[#8C1515] hover:underline"
        data-testid={`button-record-revenue-${booking.id}`}
      >
        {booking.revenueCents != null ? "Update revenue" : "Record revenue"}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <input
        value={dollars}
        onChange={(e) => setDollars(e.target.value)}
        placeholder="0.00"
        className="w-20 bg-white border border-[#E8DDD0] rounded px-2 py-1 text-xs"
        data-testid={`input-revenue-${booking.id}`}
      />
      <button
        onClick={() => record.mutate()}
        disabled={record.isPending}
        className="text-xs text-[#1a7a4a] hover:underline disabled:opacity-50"
      >
        Save
      </button>
      <button
        onClick={() => setEditing(false)}
        className="text-xs text-[#8a6a5a]"
      >
        ✕
      </button>
    </span>
  );
}

function AdminBookingControl({ booking }: { booking: FrameworkBookingItem }) {
  const qc = useQueryClient();
  const [adjusting, setAdjusting] = useState(false);
  const [shareUsd, setShareUsd] = useState(
    ((booking.ownerShareCents ?? 0) / 100).toString(),
  );
  const [note, setNote] = useState(booking.note ?? "");

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      fetchJson(`/api/faculty/frameworks/bookings/${booking.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["faculty-framework-ledger"] });
      setAdjusting(false);
    },
  });

  const saveAdjust = () => {
    const cents = Math.round(parseFloat(shareUsd || "0") * 100);
    patch.mutate({
      ownerShareCents: Number.isFinite(cents) && cents >= 0 ? cents : 0,
      note: note.trim() === "" ? null : note.trim(),
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-3">
        {booking.status === "settled" ? (
          <button
            onClick={() => patch.mutate({ status: "booked" })}
            disabled={patch.isPending}
            className="text-xs text-[#8a6a5a] hover:underline disabled:opacity-50"
          >
            Unsettle
          </button>
        ) : (
          <button
            onClick={() => patch.mutate({ status: "settled" })}
            disabled={patch.isPending}
            className="text-xs text-[#1a7a4a] hover:underline disabled:opacity-50"
            data-testid={`button-settle-${booking.id}`}
          >
            Mark settled
          </button>
        )}
        <button
          onClick={() => setAdjusting((a) => !a)}
          className="text-xs text-[#8C1515] hover:underline"
          data-testid={`button-adjust-${booking.id}`}
        >
          {adjusting ? "Cancel" : "Adjust"}
        </button>
      </div>
      {adjusting && (
        <div
          className="mt-1 flex flex-col items-end gap-1 bg-[#F9F5EE] border border-[#E8DDD0] rounded-lg p-2 w-56"
          data-testid={`adjust-form-${booking.id}`}
        >
          <label className="w-full text-[10px] text-[#8a6a5a]">
            Owner share ($)
            <input
              type="number"
              min="0"
              step="0.01"
              value={shareUsd}
              onChange={(e) => setShareUsd(e.target.value)}
              className="mt-0.5 w-full bg-white border border-[#E8DDD0] rounded px-2 py-1 text-xs text-[#572020]"
              data-testid={`input-share-${booking.id}`}
            />
          </label>
          <label className="w-full text-[10px] text-[#8a6a5a]">
            Note
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="mt-0.5 w-full bg-white border border-[#E8DDD0] rounded px-2 py-1 text-xs text-[#572020]"
              data-testid={`input-note-${booking.id}`}
            />
          </label>
          <button
            onClick={saveAdjust}
            disabled={patch.isPending}
            className="mt-1 bg-[#8C1515] text-white px-3 py-1 rounded text-xs font-medium hover:bg-[#a01a1a] disabled:opacity-50"
            data-testid={`button-save-adjust-${booking.id}`}
          >
            {patch.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}

function FrameworksPage() {
  const { data: me, isLoading: meLoading } = useMe();

  // Pillars the caller stewards AND may author frameworks in (the two
  // communication pillars). Drives the create form + manage controls.
  const authorPillars = useMemo(() => {
    if (!me) return [] as Array<{ id: number; name: string }>;
    const stewardIds = new Set(
      me.memberships.filter((m) => m.role === "steward").map((m) => m.pillarId),
    );
    return me.pillars
      .filter(
        (p) =>
          stewardIds.has(p.id) && FRAMEWORK_AUTHOR_PILLAR_SLUGS.has(p.slug),
      )
      .map((p) => ({ id: p.id, name: p.name }));
  }, [me]);

  const isAdmin = !!me?.user.isPlatformAdmin;

  const mine = useQuery<{ frameworks: FrameworkItem[] }>({
    queryKey: ["faculty-frameworks"],
    queryFn: () => fetchJson("/api/faculty/frameworks"),
    enabled: !!me && !me.awaitingInvitation,
  });

  const ownerBookings = useQuery<FrameworkBookingsResp>({
    queryKey: ["faculty-framework-bookings", "owner"],
    queryFn: () => fetchJson("/api/faculty/frameworks/bookings?box=owner"),
    enabled: !!me && !me.awaitingInvitation,
  });

  const myBookings = useQuery<FrameworkBookingsResp>({
    queryKey: ["faculty-framework-bookings", "mine"],
    queryFn: () => fetchJson("/api/faculty/frameworks/bookings?box=mine"),
    enabled: !!me && !me.awaitingInvitation,
  });

  const ledger = useQuery<FrameworkBookingsResp>({
    queryKey: ["faculty-framework-ledger"],
    queryFn: () => fetchJson("/api/faculty/frameworks/bookings/ledger"),
    enabled: isAdmin,
  });

  if (meLoading) {
    return (
      <PortalShell>
        <p className="text-[#8a6a5a]">Loading…</p>
      </PortalShell>
    );
  }

  // Sellers only: stewards of the two communication pillars + platform admins.
  // Every other steward books a colleague's framework through the inline apply
  // panel, so the standalone page (and its bookings summary) isn't for them.
  if (!canAccessFrameworksPage(me)) {
    return <Redirect to="/dashboard" />;
  }

  return (
    <PortalShell>
      <div className="space-y-10" data-testid="frameworks-page">
        <header>
          <h1 className="font-serif text-3xl text-[#572020]">Frameworks</h1>
          <p className="text-[#8a6a5a] mt-2 max-w-2xl">
            Name the communication frameworks you've developed, publish them so
            stewards in other pillars can apply them to their own drafts, and
            track the deferred revenue share each booking earns. Applying a
            colleague's framework keeps every claim grounded in their approved
            knowledge and attributed to them.
          </p>
        </header>

        {authorPillars.length > 0 && (
          <section className="space-y-4">
            <FrameworkCreateForm stewardPillars={authorPillars} />
            <div className="space-y-3">
              <h2 className="font-serif text-xl text-[#572020]">
                Your frameworks
              </h2>
              {mine.isLoading ? (
                <p className="text-[#8a6a5a] text-sm">Loading…</p>
              ) : (mine.data?.frameworks.length ?? 0) === 0 ? (
                <p className="text-[#8a6a5a] text-sm">
                  No frameworks yet — create one above.
                </p>
              ) : (
                mine.data!.frameworks.map((f) => (
                  <FrameworkRow key={f.id} framework={f} />
                ))
              )}
            </div>
          </section>
        )}

        <section className="space-y-3">
          <h2 className="font-serif text-xl text-[#572020]">
            Booked by other pillars
          </h2>
          <p className="text-sm text-[#8a6a5a]">
            {ownerBookings.data
              ? `Booked ${ownerBookings.data.summary.count} time${
                  ownerBookings.data.summary.count === 1 ? "" : "s"
                } · owed to you ${fwUsd(ownerBookings.data.summary.owedCents)}`
              : "Loading…"}
          </p>
          {(ownerBookings.data?.bookings.length ?? 0) > 0 && (
            <BookingsTable
              rows={ownerBookings.data!.bookings}
              perspective="owner"
            />
          )}
        </section>

        <section className="space-y-3">
          <h2 className="font-serif text-xl text-[#572020]">Your bookings</h2>
          <p className="text-sm text-[#8a6a5a]">
            {myBookings.data
              ? `${myBookings.data.summary.count} booking${
                  myBookings.data.summary.count === 1 ? "" : "s"
                } · owed out of revenue ${fwUsd(
                  myBookings.data.summary.owedCents,
                )}`
              : "Loading…"}
          </p>
          {(myBookings.data?.bookings.length ?? 0) > 0 && (
            <BookingsTable
              rows={myBookings.data!.bookings}
              perspective="mine"
            />
          )}
        </section>

        {isAdmin && (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-serif text-xl text-[#572020]">
                Revenue-share ledger
              </h2>
              <a
                href="/api/faculty/frameworks/bookings/ledger.csv"
                className="text-xs text-[#8C1515] hover:underline"
                data-testid="link-ledger-csv"
              >
                Export CSV
              </a>
            </div>
            <p className="text-sm text-[#8a6a5a]">
              {ledger.data
                ? `${ledger.data.summary.count} bookings · owed ${fwUsd(
                    ledger.data.summary.owedCents,
                  )} · settled ${fwUsd(ledger.data.summary.settledCents)}`
                : "Loading…"}
            </p>
            {(ledger.data?.bookings.length ?? 0) > 0 && (
              <BookingsTable rows={ledger.data!.bookings} perspective="admin" />
            )}
          </section>
        )}
      </div>
    </PortalShell>
  );
}

function BookingsTable({
  rows,
  perspective,
}: {
  rows: FrameworkBookingItem[];
  perspective: "owner" | "mine" | "admin";
}) {
  return (
    <div className="overflow-x-auto border border-[#E8DDD0] rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-[#F4ECDD] text-[#8a6a5a] text-left">
          <tr>
            <th className="px-3 py-2 font-medium">Framework</th>
            {perspective !== "owner" && (
              <th className="px-3 py-2 font-medium">Owner</th>
            )}
            {perspective !== "mine" && (
              <th className="px-3 py-2 font-medium">Booker</th>
            )}
            <th className="px-3 py-2 font-medium">Used on</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Revenue</th>
            <th className="px-3 py-2 font-medium">Share</th>
            <th className="px-3 py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr
              key={b.id}
              className="border-t border-[#E8DDD0]"
              data-testid={`booking-row-${b.id}`}
            >
              <td className="px-3 py-2 text-[#572020]">{b.frameworkName}</td>
              {perspective !== "owner" && (
                <td className="px-3 py-2 text-[#8a6a5a]">
                  {b.ownerName ?? "—"}
                  <span className="block text-[10px]">{b.ownerPillarName}</span>
                </td>
              )}
              {perspective !== "mine" && (
                <td className="px-3 py-2 text-[#8a6a5a]">
                  {b.bookerName ?? "—"}
                  <span className="block text-[10px]">
                    {b.bookerPillarName}
                  </span>
                </td>
              )}
              <td className="px-3 py-2 text-[#8a6a5a]">
                {b.targetTitle ??
                  (b.targetType ? TARGET_LABEL[b.targetType] : "—")}
              </td>
              <td className="px-3 py-2 text-[#8a6a5a]">{b.status}</td>
              <td className="px-3 py-2 text-[#8a6a5a]">
                {b.revenueCents != null ? fwUsd(b.revenueCents) : "—"}
              </td>
              <td className="px-3 py-2 text-[#572020]">
                {fwUsd(b.ownerShareCents)}{" "}
                <span className="text-[10px] text-[#8a6a5a]">
                  ({b.sharePct}%)
                </span>
              </td>
              <td className="px-3 py-2">
                {perspective === "mine" && (
                  <BookingRevenueControl booking={b} />
                )}
                {perspective === "admin" && <AdminBookingControl booking={b} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Read-only "frameworks I've booked" card for NON-SELLER stewards. The standalone
 * /frameworks page (with its richer "Your bookings" table + revenue controls) is
 * restricted to framework sellers + admins, so a steward who books a colleague's
 * framework through the inline apply panel otherwise has nowhere to review their
 * own cross-pillar usage. This is fully self-contained: it gates internally on
 * NOT having frameworks-page access and renders nothing when there are no
 * bookings, so it can be dropped onto the dashboard unconditionally.
 */
function MyFrameworkBookingsCard() {
  const { data: me } = useMe();
  const enabled =
    !!me && !me.awaitingInvitation && !canAccessFrameworksPage(me);
  const { data } = useQuery<FrameworkBookingsResp>({
    queryKey: ["faculty-framework-bookings", "mine"],
    queryFn: () => fetchJson("/api/faculty/frameworks/bookings?box=mine"),
    enabled,
  });

  if (!enabled || !data || data.bookings.length === 0) return null;

  return (
    <section
      className="mt-12 rounded-2xl border border-[#E8DDD0] bg-white/50 p-6"
      data-testid="my-framework-bookings"
    >
      <h2 className="font-serif text-xl text-[#572020]">
        Frameworks you've booked
      </h2>
      <p className="mt-1 text-sm text-[#8a6a5a]">
        {`${data.summary.count} booking${
          data.summary.count === 1 ? "" : "s"
        } across other pillars.`}
      </p>
      <ul className="mt-4 divide-y divide-[#E8DDD0]">
        {data.bookings.map((b) => (
          <li
            key={b.id}
            className="flex items-baseline justify-between gap-4 py-2.5"
            data-testid={`my-booking-${b.id}`}
          >
            <div>
              <span className="text-[#572020]">
                {b.frameworkName ?? "Framework"}
              </span>
              <span className="block text-xs text-[#8a6a5a]">
                {b.ownerName ? `${b.ownerName} · ` : ""}
                {b.ownerPillarName ?? ""}
              </span>
            </div>
            <span className="shrink-0 text-xs text-[#8a6a5a]">
              {b.targetTitle ??
                (b.targetType ? TARGET_LABEL[b.targetType] : "—")}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HomeRedirect() {
  const { isSignedIn } = useUser();
  if (isSignedIn === true) return <Redirect to="/dashboard" />;
  if (isSignedIn === false && isAslmEntry()) {
    return <Redirect to="/sign-in?aslm=1" />;
  }
  if (isSignedIn === false) return <Landing />;
  return null;
}

// ── Decision Room ───────────────────────────────────────────────────────────
// Chat-built Amazon-style six-page decision memos: the platform admin drafts
// via a chat with Pal, checks claims against the governed corpus, and shares
// memos with selected faculty for read + per-page comments.

const DECISION_PAGE_TITLES = [
  "Decision & recommendation",
  "Context",
  "Proposal details",
  "Top risks & mitigations",
  "Numbers & sensitivity",
  "Implementation, people & the ask",
];

interface DecisionMemoListItem {
  id: number;
  title: string;
  topic: string;
  status: "draft" | "shared" | "decided";
  owner: string;
  decidedAt: string | null;
  decidedOutcome: string | null;
  scienceCheckPassed: boolean | null;
  updatedAt: string;
}

interface DecisionVerdict {
  page: number;
  claim: string;
  verdict: "supported" | "contradicted" | "not_covered";
  citation: {
    sourceId: number;
    title: string;
    authors: string | null;
    year: number | null;
    journal: string | null;
    doi: string | null;
  } | null;
  note: string;
}

interface DecisionMemoDetail {
  id: number;
  title: string;
  topic: string;
  status: "draft" | "shared" | "decided";
  decidedOutcome: string | null;
  decidedAt: string | null;
  pages: string[];
  scienceCheck: DecisionVerdict[] | null;
  scienceCheckedAt: string | null;
  scienceCheckPassed: boolean | null;
  canEdit: boolean;
}

function DecisionStatusBadge({
  status,
}: {
  status: DecisionMemoListItem["status"];
}) {
  const styles: Record<string, string> = {
    draft: "bg-[#f0e9dd] text-[#8a6a5a]",
    shared: "bg-[#e3ecf5] text-[#2b5a8a]",
    decided: "bg-[#e5efe2] text-[#3a6b3a]",
  };
  const labels: Record<string, string> = {
    draft: "Draft",
    shared: "Shared",
    decided: "Decided",
  };
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full font-medium ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}

function DecisionLibraryPage() {
  const { data: me } = useMe();
  const [, setLocation] = useLocation();
  const [q, setQ] = useState("");
  const isAdmin = !!me?.user.isPlatformAdmin;
  const { data, isLoading } = useQuery<{ memos: DecisionMemoListItem[] }>({
    queryKey: ["decision-memos", q],
    queryFn: () =>
      fetchJson(
        `/api/faculty/decision-room/memos${q ? `?q=${encodeURIComponent(q)}` : ""}`,
      ),
    enabled: !!me,
  });
  const qc = useQueryClient();
  const createMemo = useMutation({
    mutationFn: (title: string) =>
      fetchJson<{ memo: DecisionMemoDetail }>(
        "/api/faculty/decision-room/memos",
        {
          method: "POST",
          body: JSON.stringify({ title }),
        },
      ),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["decision-memos"] });
      setLocation(`/decisions/${res.memo.id}`);
    },
  });
  return (
    <PortalShell>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-[#2e2018]">
            Decision Library
          </h1>
          <p className="text-sm text-[#8a6a5a] mt-1">
            Six-page decision memos, checked against the science.
          </p>
        </div>
        {isAdmin && (
          <button
            data-testid="button-new-memo"
            onClick={() => {
              const title = window.prompt(
                "Memo title (the decision in one line):",
              );
              if (title?.trim()) createMemo.mutate(title.trim());
            }}
            className="bg-[#8C1515] text-white px-4 py-2 rounded-lg text-sm hover:bg-[#6e1010] transition"
          >
            New memo
          </button>
        )}
      </div>
      <input
        data-testid="input-memo-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by title or topic…"
        className="w-full mb-4 px-3 py-2 rounded-lg border border-[#e0d5c5] bg-white text-sm"
      />
      {isLoading ? (
        <p className="text-sm text-[#8a6a5a]">Loading…</p>
      ) : (data?.memos ?? []).length === 0 ? (
        <p className="text-sm text-[#8a6a5a]" data-testid="text-no-memos">
          No memos yet.
        </p>
      ) : (
        <div className="space-y-2">
          {(data?.memos ?? []).map((m) => (
            <Link
              key={m.id}
              href={`/decisions/${m.id}`}
              data-testid={`link-memo-${m.id}`}
              className="block bg-white rounded-lg border border-[#e8ddd0] px-4 py-3 hover:border-[#8C1515] transition"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium text-[#2e2018] truncate">
                    {m.title}
                  </div>
                  <div className="text-xs text-[#8a6a5a] mt-0.5 truncate">
                    {m.owner}
                    {m.topic ? ` · ${m.topic}` : ""}
                    {m.decidedAt
                      ? ` · decided ${new Date(m.decidedAt).toLocaleDateString()}`
                      : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {m.scienceCheckPassed != null && (
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        m.scienceCheckPassed
                          ? "bg-[#e5efe2] text-[#3a6b3a]"
                          : "bg-[#f7e4e0] text-[#8C1515]"
                      }`}
                    >
                      {m.scienceCheckPassed ? "Science ✓" : "Science ✗"}
                    </span>
                  )}
                  <DecisionStatusBadge status={m.status} />
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </PortalShell>
  );
}

interface DecisionComment {
  id: number;
  page: number;
  body: string;
  author: string;
  createdAt: string;
}

function DecisionMemoPage() {
  const params = useParams<{ id: string }>();
  const memoId = Number(params.id);
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const { data: me } = useMe();

  const memoQuery = useQuery<{ memo: DecisionMemoDetail }>({
    queryKey: ["decision-memo", memoId],
    queryFn: () => fetchJson(`/api/faculty/decision-room/memos/${memoId}`),
    enabled: Number.isInteger(memoId),
  });
  const memo = memoQuery.data?.memo;

  const [activePage, setActivePage] = useState(0);
  const [pages, setPages] = useState<string[] | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (memo && (!dirty || pages == null)) {
      setPages(memo.pages);
      setDirty(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memo?.pages?.join("\u0000")]);

  const saveMemo = useMutation({
    mutationFn: (nextPages: string[]) =>
      fetchJson<{ memo: DecisionMemoDetail }>(
        `/api/faculty/decision-room/memos/${memoId}`,
        { method: "PATCH", body: JSON.stringify({ pages: nextPages }) },
      ),
    onSuccess: (res) => {
      qc.setQueryData(["decision-memo", memoId], res);
      qc.invalidateQueries({ queryKey: ["decision-memos"] });
      setDirty(false);
    },
  });

  // ── Chat ──
  const [chatMessages, setChatMessages] = useState<
    Array<{ role: "user" | "assistant"; content: string }>
  >([]);
  const [chatInput, setChatInput] = useState("");
  const chat = useMutation({
    mutationFn: (message: string) =>
      fetchJson<{
        reply: string;
        updatedPages: number[];
        memo: DecisionMemoDetail;
      }>(`/api/faculty/decision-room/memos/${memoId}/chat`, {
        method: "POST",
        body: JSON.stringify({ message, history: chatMessages.slice(-12) }),
      }),
    onSuccess: (res, message) => {
      setChatMessages((prev) => [
        ...prev,
        { role: "user", content: message },
        { role: "assistant", content: res.reply || "(pages updated)" },
      ]);
      qc.setQueryData(["decision-memo", memoId], { memo: res.memo });
      setPages(res.memo.pages);
      setDirty(false);
      if (res.updatedPages.length > 0) setActivePage(res.updatedPages[0] - 1);
    },
  });

  // ── Science check ──
  const scienceCheck = useMutation({
    mutationFn: () =>
      fetchJson<{ memo: DecisionMemoDetail }>(
        `/api/faculty/decision-room/memos/${memoId}/science-check`,
        { method: "POST", body: JSON.stringify({}) },
      ),
    onSuccess: (res) => {
      qc.setQueryData(["decision-memo", memoId], res);
      qc.invalidateQueries({ queryKey: ["decision-memos"] });
    },
  });

  // ── Lifecycle ──
  const setStatus = useMutation({
    mutationFn: (body: { status: string; decidedOutcome?: string }) =>
      fetchJson<{ memo: DecisionMemoDetail }>(
        `/api/faculty/decision-room/memos/${memoId}/status`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: (res) => {
      qc.setQueryData(["decision-memo", memoId], res);
      qc.invalidateQueries({ queryKey: ["decision-memos"] });
    },
  });
  const deleteMemo = useMutation({
    mutationFn: () =>
      fetchJson(`/api/faculty/decision-room/memos/${memoId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["decision-memos"] });
      setLocation("/decisions");
    },
  });

  // ── Sharing ──
  const [shareOpen, setShareOpen] = useState(false);
  const membersQuery = useQuery<{
    members: Array<{ id: number; name: string; email: string }>;
  }>({
    queryKey: ["decision-members"],
    queryFn: () => fetchJson("/api/faculty/decision-room/members"),
    enabled: shareOpen && !!memo?.canEdit && !!me?.user.isPlatformAdmin,
  });
  const sharesQuery = useQuery<{
    shares: Array<{ userId: number; name: string; email: string }>;
  }>({
    queryKey: ["decision-shares", memoId],
    queryFn: () =>
      fetchJson(`/api/faculty/decision-room/memos/${memoId}/shares`),
    enabled: !!memo,
  });
  const [selectedShares, setSelectedShares] = useState<Set<number> | null>(
    null,
  );
  useEffect(() => {
    if (sharesQuery.data && selectedShares == null) {
      setSelectedShares(new Set(sharesQuery.data.shares.map((s) => s.userId)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharesQuery.data]);
  const saveShares = useMutation({
    mutationFn: (userIds: number[]) =>
      fetchJson(`/api/faculty/decision-room/memos/${memoId}/shares`, {
        method: "PUT",
        body: JSON.stringify({ userIds }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["decision-shares", memoId] });
      qc.invalidateQueries({ queryKey: ["decision-memo", memoId] });
      qc.invalidateQueries({ queryKey: ["decision-memos"] });
      setShareOpen(false);
    },
  });

  // ── Comments ──
  const commentsQuery = useQuery<{ comments: DecisionComment[] }>({
    queryKey: ["decision-comments", memoId],
    queryFn: () =>
      fetchJson(`/api/faculty/decision-room/memos/${memoId}/comments`),
    enabled: !!memo,
  });
  const [commentDraft, setCommentDraft] = useState("");
  const addComment = useMutation({
    mutationFn: (body: { page: number; body: string }) =>
      fetchJson(`/api/faculty/decision-room/memos/${memoId}/comments`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setCommentDraft("");
      qc.invalidateQueries({ queryKey: ["decision-comments", memoId] });
    },
  });

  if (memoQuery.isLoading || !pages) {
    return (
      <PortalShell>
        <p className="text-sm text-[#8a6a5a]">Loading…</p>
      </PortalShell>
    );
  }
  if (!memo) {
    return (
      <PortalShell>
        <p className="text-sm text-[#8a6a5a]">Memo not found.</p>
      </PortalShell>
    );
  }

  const pageVerdicts = (memo.scienceCheck ?? []).filter(
    (v) => v.page === activePage + 1,
  );
  const pageComments = (commentsQuery.data?.comments ?? []).filter(
    (c) => c.page === activePage + 1,
  );

  return (
    <PortalShell>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          <Link
            href="/decisions"
            className="text-xs text-[#8a6a5a] hover:text-[#8C1515]"
          >
            ← Decision Library
          </Link>
          <h1
            className="text-xl font-semibold text-[#2e2018] truncate"
            data-testid="text-memo-title"
          >
            {memo.title}
          </h1>
          <div className="flex items-center gap-2 mt-1">
            <DecisionStatusBadge status={memo.status} />
            {memo.scienceCheckPassed != null && (
              <span
                className={`text-xs px-2 py-0.5 rounded-full ${
                  memo.scienceCheckPassed
                    ? "bg-[#e5efe2] text-[#3a6b3a]"
                    : "bg-[#f7e4e0] text-[#8C1515]"
                }`}
                data-testid="badge-science-check"
              >
                {memo.scienceCheckPassed
                  ? "Science check passed"
                  : "Science check flagged"}
              </span>
            )}
            {memo.status === "decided" && memo.decidedOutcome && (
              <span className="text-xs text-[#8a6a5a]">
                Outcome: {memo.decidedOutcome}
              </span>
            )}
          </div>
        </div>
        {memo.canEdit && (
          <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
            <button
              data-testid="button-science-check"
              onClick={() => scienceCheck.mutate()}
              disabled={scienceCheck.isPending}
              className="text-sm border border-[#8C1515] text-[#8C1515] px-3 py-1.5 rounded-lg hover:bg-[#8C1515] hover:text-white transition disabled:opacity-50"
            >
              {scienceCheck.isPending
                ? "Checking…"
                : "Check against the science"}
            </button>
            <button
              data-testid="button-share-memo"
              onClick={() => setShareOpen((v) => !v)}
              className="text-sm border border-[#e0d5c5] px-3 py-1.5 rounded-lg hover:border-[#8C1515] transition"
            >
              Share
            </button>
            {memo.status !== "decided" && (
              <button
                data-testid="button-record-decision"
                onClick={() => {
                  const outcome = window.prompt("Record the decision outcome:");
                  if (outcome?.trim())
                    setStatus.mutate({
                      status: "decided",
                      decidedOutcome: outcome.trim(),
                    });
                }}
                className="text-sm border border-[#e0d5c5] px-3 py-1.5 rounded-lg hover:border-[#8C1515] transition"
              >
                Record decision
              </button>
            )}
            {memo.status === "decided" && (
              <button
                onClick={() => setStatus.mutate({ status: "shared" })}
                className="text-sm border border-[#e0d5c5] px-3 py-1.5 rounded-lg hover:border-[#8C1515] transition"
              >
                Reopen
              </button>
            )}
            <button
              data-testid="button-delete-memo"
              onClick={() => {
                if (window.confirm("Delete this memo? This cannot be undone."))
                  deleteMemo.mutate();
              }}
              className="text-sm text-[#8a6a5a] px-2 py-1.5 hover:text-[#8C1515] transition"
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {shareOpen && memo.canEdit && (
        <div className="bg-white border border-[#e8ddd0] rounded-lg p-4 mb-4">
          <div className="text-sm font-medium text-[#2e2018] mb-2">
            Share with faculty (read + comment)
          </div>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {(membersQuery.data?.members ?? []).map((m) => (
              <label
                key={m.id}
                className="flex items-center gap-2 text-sm text-[#2e2018]"
              >
                <input
                  type="checkbox"
                  data-testid={`checkbox-share-${m.id}`}
                  checked={selectedShares?.has(m.id) ?? false}
                  onChange={(e) => {
                    setSelectedShares((prev) => {
                      const next = new Set(prev ?? []);
                      if (e.target.checked) next.add(m.id);
                      else next.delete(m.id);
                      return next;
                    });
                  }}
                />
                {m.name}{" "}
                <span className="text-xs text-[#8a6a5a]">{m.email}</span>
              </label>
            ))}
            {membersQuery.data && membersQuery.data.members.length === 0 && (
              <p className="text-xs text-[#8a6a5a]">
                No other faculty accounts.
              </p>
            )}
          </div>
          <button
            data-testid="button-save-shares"
            onClick={() => saveShares.mutate([...(selectedShares ?? [])])}
            disabled={saveShares.isPending}
            className="mt-3 bg-[#8C1515] text-white px-3 py-1.5 rounded-lg text-sm hover:bg-[#6e1010] transition disabled:opacity-50"
          >
            Save sharing
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Pages */}
        <div className="lg:col-span-2">
          <div className="flex gap-1 mb-3 flex-wrap">
            {DECISION_PAGE_TITLES.map((t, i) => (
              <button
                key={i}
                data-testid={`tab-page-${i + 1}`}
                onClick={() => setActivePage(i)}
                className={`text-xs px-3 py-1.5 rounded-full transition ${
                  activePage === i
                    ? "bg-[#8C1515] text-white"
                    : "bg-white border border-[#e0d5c5] text-[#8a6a5a] hover:border-[#8C1515]"
                }`}
              >
                {i + 1}. {t}
              </button>
            ))}
          </div>
          <div className="bg-white border border-[#e8ddd0] rounded-lg p-4">
            <div className="text-sm font-medium text-[#2e2018] mb-2">
              Page {activePage + 1}: {DECISION_PAGE_TITLES[activePage]}
            </div>
            {memo.canEdit ? (
              <>
                <textarea
                  data-testid={`textarea-page-${activePage + 1}`}
                  value={pages[activePage]}
                  onChange={(e) => {
                    const next = [...pages];
                    next[activePage] = e.target.value;
                    setPages(next);
                    setDirty(true);
                  }}
                  rows={16}
                  className="w-full border border-[#e0d5c5] rounded-lg p-3 text-sm leading-relaxed"
                  placeholder="Prose, not bullets. Draft it with Pal in the chat, or write directly."
                />
                {dirty && (
                  <button
                    data-testid="button-save-pages"
                    onClick={() => saveMemo.mutate(pages)}
                    disabled={saveMemo.isPending}
                    className="mt-2 bg-[#8C1515] text-white px-3 py-1.5 rounded-lg text-sm hover:bg-[#6e1010] transition disabled:opacity-50"
                  >
                    {saveMemo.isPending ? "Saving…" : "Save changes"}
                  </button>
                )}
              </>
            ) : (
              <div
                className="text-sm leading-relaxed whitespace-pre-wrap text-[#2e2018]"
                data-testid={`text-page-${activePage + 1}`}
              >
                {pages[activePage].trim() || (
                  <span className="text-[#8a6a5a]">(empty)</span>
                )}
              </div>
            )}
          </div>

          {/* Science check results for this page */}
          {memo.scienceCheck != null && (
            <div className="mt-4 bg-white border border-[#e8ddd0] rounded-lg p-4">
              <div className="text-sm font-medium text-[#2e2018] mb-2">
                Science check — page {activePage + 1}
                {memo.scienceCheckedAt && (
                  <span className="text-xs text-[#8a6a5a] font-normal ml-2">
                    checked {new Date(memo.scienceCheckedAt).toLocaleString()}
                  </span>
                )}
              </div>
              {pageVerdicts.length === 0 ? (
                <p className="text-xs text-[#8a6a5a]">
                  No checkable scientific claims on this page.
                </p>
              ) : (
                <div className="space-y-2">
                  {pageVerdicts.map((v, i) => (
                    <div
                      key={i}
                      className="text-sm border-l-2 pl-3 py-1"
                      style={{
                        borderColor:
                          v.verdict === "supported"
                            ? "#3a6b3a"
                            : v.verdict === "contradicted"
                              ? "#8C1515"
                              : "#b8a68f",
                      }}
                    >
                      <div className="text-[#2e2018]">{v.claim}</div>
                      <div className="text-xs mt-0.5">
                        {v.verdict === "supported" && (
                          <span className="text-[#3a6b3a] font-medium">
                            Supported
                          </span>
                        )}
                        {v.verdict === "contradicted" && (
                          <span className="text-[#8C1515] font-medium">
                            Contradicted
                          </span>
                        )}
                        {v.verdict === "not_covered" && (
                          <span className="text-[#8a6a5a] font-medium">
                            Not covered by the approved corpus
                          </span>
                        )}
                        {v.citation && (
                          <span className="text-[#8a6a5a]">
                            {" — "}
                            {[
                              v.citation.authors,
                              v.citation.year ? `(${v.citation.year})` : null,
                              v.citation.title,
                            ]
                              .filter(Boolean)
                              .join(" ")}
                          </span>
                        )}
                        {v.note && (
                          <span className="text-[#8a6a5a]"> · {v.note}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Comments for this page */}
          <div className="mt-4 bg-white border border-[#e8ddd0] rounded-lg p-4">
            <div className="text-sm font-medium text-[#2e2018] mb-2">
              Comments — page {activePage + 1}
            </div>
            {pageComments.length === 0 ? (
              <p className="text-xs text-[#8a6a5a] mb-2">
                No comments on this page yet.
              </p>
            ) : (
              <div className="space-y-2 mb-2">
                {pageComments.map((c) => (
                  <div
                    key={c.id}
                    className="text-sm"
                    data-testid={`comment-${c.id}`}
                  >
                    <span className="font-medium text-[#2e2018]">
                      {c.author}
                    </span>{" "}
                    <span className="text-xs text-[#8a6a5a]">
                      {new Date(c.createdAt).toLocaleString()}
                    </span>
                    <div className="text-[#2e2018] whitespace-pre-wrap">
                      {c.body}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                data-testid="input-comment"
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                placeholder="Leave a comment on this page…"
                className="flex-1 border border-[#e0d5c5] rounded-lg px-3 py-1.5 text-sm"
              />
              <button
                data-testid="button-add-comment"
                onClick={() => {
                  if (commentDraft.trim())
                    addComment.mutate({
                      page: activePage + 1,
                      body: commentDraft.trim(),
                    });
                }}
                disabled={addComment.isPending || !commentDraft.trim()}
                className="text-sm border border-[#e0d5c5] px-3 py-1.5 rounded-lg hover:border-[#8C1515] transition disabled:opacity-50"
              >
                Comment
              </button>
            </div>
          </div>
        </div>

        {/* Chat with Pal */}
        {memo.canEdit && (
          <div className="bg-white border border-[#e8ddd0] rounded-lg p-4 h-fit lg:sticky lg:top-4">
            <div className="text-sm font-medium text-[#2e2018] mb-2">
              Draft with Pal
            </div>
            <p className="text-xs text-[#8a6a5a] mb-3">
              Pal interviews you section by section and drafts each page as
              prose. Ask it to revise any page.
            </p>
            <div
              className="space-y-2 max-h-80 overflow-y-auto mb-3"
              data-testid="chat-messages"
            >
              {chatMessages.length === 0 && (
                <p className="text-xs text-[#8a6a5a] italic">
                  Try: "Help me build this memo" or "Revise page 4 to sharpen
                  the mitigations."
                </p>
              )}
              {chatMessages.map((m, i) => (
                <div
                  key={i}
                  className={`text-sm rounded-lg px-3 py-2 whitespace-pre-wrap ${
                    m.role === "user"
                      ? "bg-[#f0e9dd] text-[#2e2018] ml-6"
                      : "bg-[#faf6ef] text-[#2e2018] mr-6 border border-[#e8ddd0]"
                  }`}
                >
                  {m.content}
                </div>
              ))}
              {chat.isPending && (
                <div className="text-xs text-[#8a6a5a] italic">
                  Pal is thinking…
                </div>
              )}
              {chat.isError && (
                <div className="text-xs text-[#8C1515]">
                  Drafting failed, try again.
                </div>
              )}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const msg = chatInput.trim();
                if (msg && !chat.isPending) {
                  setChatInput("");
                  chat.mutate(msg);
                }
              }}
              className="flex gap-2"
            >
              <input
                data-testid="input-chat"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Tell Pal about the decision…"
                className="flex-1 border border-[#e0d5c5] rounded-lg px-3 py-1.5 text-sm"
              />
              <button
                type="submit"
                data-testid="button-chat-send"
                disabled={chat.isPending || !chatInput.trim()}
                className="bg-[#8C1515] text-white px-3 py-1.5 rounded-lg text-sm hover:bg-[#6e1010] transition disabled:opacity-50"
              >
                Send
              </button>
            </form>
          </div>
        )}
      </div>
    </PortalShell>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Show when="signed-in">{children}</Show>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
    </>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsub = addListener(({ user }) => {
      const id = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== id) {
        // Identity changed (sign-out or user switch). Drop any active admin
        // "view-as" preview so a stale module-level _viewAs can never leak
        // into another session and suppress /welcome for a real first login.
        setViewAs(null);
        qc.clear();
      }
      prevUserIdRef.current = id;
    });
    return unsub;
  }, [addListener, qc]);
  return null;
}

// ---------- Eval harness pages ----------

interface EvalRunRow {
  id: number;
  name: string;
  notes: string | null;
  targetUrl: string;
  buildRef: string | null;
  totalItems: number;
  completedItems: number;
  citationVerifiedRate: number | null;
  citationUnmatchedRate: number | null;
  citationMissingRate: number | null;
  coverageRate: number | null;
  refusalComplianceRate: number | null;
  uncoveredHonestyRate: number | null;
  medianLatencyMs: number | null;
  createdAt: string;
  completedAt: string | null;
}

interface EvalItemRow {
  id: number;
  seedIndex: number;
  question: string;
  expectedOutcome: "covered" | "uncovered" | "refuse";
  category: string;
  answerText: string;
  latencyMs: number;
  runError: string | null;
  alreadyGraded: boolean;
  citationVerification?: string | null;
  wasUncovered?: boolean;
  wasRefused?: boolean;
  governedUsed?: boolean;
  topScore?: number;
}

function fmtPct(r: number | null | undefined): string {
  if (r === null || r === undefined) return "n/a";
  return `${(r * 100).toFixed(1)}%`;
}

function EvalIndexPage() {
  const { data, isLoading, error } = useQuery<{ runs: EvalRunRow[] }>({
    queryKey: ["eval-runs"],
    queryFn: () => fetchJson("/api/faculty/evals/runs"),
  });
  return (
    <PortalShell>
      <h1 className="font-serif text-3xl font-medium mb-2">Eval runs</h1>
      <p className="text-[#8a6a5a] mb-6 text-sm">
        Blinded faculty-graded eval harness. Each run executes the seed set
        against /api/sleep-agent and records what came back. Auto-metrics below;
        click in to grade individual items.
      </p>
      {isLoading && <p className="text-[#8a6a5a]">Loading…</p>}
      {error && <p className="text-[#E8352A]">{(error as Error).message}</p>}
      {data && data.runs.length === 0 && (
        <p className="text-[#8a6a5a] text-sm">
          No runs yet. From the repo root:{" "}
          <code className="bg-[#F0E8DC] px-1.5 py-0.5 rounded text-[#572020]">
            pnpm --filter @workspace/scripts run eval
          </code>
        </p>
      )}
      <div className="grid gap-3">
        {data?.runs.map((r) => (
          <Link
            key={r.id}
            href={`/evals/${r.id}`}
            className="block bg-white border border-[#E8DDD0] rounded-lg p-4 hover:border-[#8C1515] transition-colors"
            data-testid={`link-eval-run-${r.id}`}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-medium text-[#572020]">{r.name}</div>
                <div className="text-xs text-[#8a6a5a] mt-0.5">
                  {new Date(r.createdAt).toLocaleString()} · {r.completedItems}/
                  {r.totalItems} items
                  {r.buildRef ? ` · ${r.buildRef.slice(0, 8)}` : ""}
                </div>
                {r.notes && (
                  <div className="text-xs text-[#8a6a5a] mt-1 italic">
                    {r.notes}
                  </div>
                )}
              </div>
              <div className="text-right text-xs text-[#572020] shrink-0">
                <div>
                  citation verified:{" "}
                  <span className="font-mono font-medium">
                    {fmtPct(r.citationVerifiedRate)}
                  </span>
                </div>
                <div>
                  coverage:{" "}
                  <span className="font-mono font-medium">
                    {fmtPct(r.coverageRate)}
                  </span>
                </div>
                <div>
                  refusal:{" "}
                  <span className="font-mono font-medium">
                    {fmtPct(r.refusalComplianceRate)}
                  </span>
                </div>
                <div>
                  uncov. honesty:{" "}
                  <span className="font-mono font-medium">
                    {fmtPct(r.uncoveredHonestyRate)}
                  </span>
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </PortalShell>
  );
}

interface GradeForm {
  groundedness: number;
  helpfulness: number;
  accuracy: number;
  hallucinated: boolean;
  notes: string;
}

function GradeItemCard({
  item,
  unblinded,
  onGraded,
}: {
  item: EvalItemRow;
  unblinded: boolean;
  onGraded: () => void;
}) {
  const [form, setForm] = useState<GradeForm>({
    groundedness: 3,
    helpfulness: 3,
    accuracy: 3,
    hallucinated: false,
    notes: "",
  });
  const [showAnswer, setShowAnswer] = useState(false);
  const submit = useMutation({
    mutationFn: () =>
      fetchJson(`/api/faculty/evals/items/${item.id}/grade`, {
        method: "POST",
        body: JSON.stringify({
          groundedness: form.groundedness,
          helpfulness: form.helpfulness,
          accuracy: form.accuracy,
          hallucinated: form.hallucinated,
          notes: form.notes || null,
        }),
      }),
    onSuccess: () => onGraded(),
  });

  return (
    <div
      className="bg-white border border-[#E8DDD0] rounded-lg p-5"
      data-testid={`card-eval-item-${item.id}`}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-[#8a6a5a] font-mono">
          #{item.seedIndex} · {item.category}
        </span>
        {item.alreadyGraded && (
          <span className="text-xs text-[#0a7a4f] bg-[#E8F4EE] px-2 py-0.5 rounded">
            you already graded this
          </span>
        )}
      </div>
      <div className="font-serif text-lg text-[#572020] mb-3">
        {item.question}
      </div>
      {item.runError ? (
        <div className="text-sm text-[#E8352A] mb-3">
          run error: {item.runError}
        </div>
      ) : !showAnswer ? (
        <button
          type="button"
          onClick={() => setShowAnswer(true)}
          className="text-sm text-[#8C1515] hover:underline mb-3"
          data-testid={`button-show-answer-${item.id}`}
        >
          Show answer →
        </button>
      ) : (
        <pre className="whitespace-pre-wrap text-sm text-[#572020] bg-[#FBF7F0] border border-[#E8DDD0] rounded p-3 mb-3 font-sans leading-relaxed">
          {item.answerText || "(empty)"}
        </pre>
      )}
      {unblinded && (
        <div className="text-xs text-[#8a6a5a] mb-3 font-mono">
          expected={item.expectedOutcome} · refused={String(item.wasRefused)} ·
          uncovered={String(item.wasUncovered)} · governed=
          {String(item.governedUsed)} · cite=
          {item.citationVerification ?? "n/a"} · top=
          {item.topScore?.toFixed(3) ?? "?"} · {item.latencyMs}ms
        </div>
      )}

      {showAnswer && !item.runError && (
        <div className="grid gap-3">
          {(["groundedness", "helpfulness", "accuracy"] as const).map((k) => (
            <div key={k} className="flex items-center gap-3">
              <label className="text-xs text-[#572020] w-28 capitalize">
                {k}
              </label>
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, [k]: n }))}
                  className={`w-8 h-8 rounded border text-sm ${
                    form[k] === n
                      ? "bg-[#8C1515] text-white border-[#8C1515]"
                      : "bg-white text-[#572020] border-[#E8DDD0]"
                  }`}
                  data-testid={`button-${k}-${n}-${item.id}`}
                >
                  {n}
                </button>
              ))}
            </div>
          ))}
          <label className="flex items-center gap-2 text-sm text-[#572020]">
            <input
              type="checkbox"
              checked={form.hallucinated}
              onChange={(e) =>
                setForm((f) => ({ ...f, hallucinated: e.target.checked }))
              }
              data-testid={`checkbox-hallucinated-${item.id}`}
            />
            Hallucination — the answer misrepresents the cited source, or cites
            something that doesn't exist.
          </label>
          <textarea
            placeholder="Notes (optional)"
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            className="text-sm border border-[#E8DDD0] rounded p-2 min-h-16 bg-white text-[#572020]"
            data-testid={`textarea-notes-${item.id}`}
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => submit.mutate()}
              disabled={submit.isPending}
              className="bg-[#8C1515] text-white px-4 py-2 rounded text-sm hover:bg-[#7a1212] disabled:opacity-50"
              data-testid={`button-submit-grade-${item.id}`}
            >
              {submit.isPending
                ? "Submitting…"
                : item.alreadyGraded
                  ? "Update grade"
                  : "Submit grade"}
            </button>
            {submit.error && (
              <span className="text-xs text-[#E8352A]">
                {(submit.error as Error).message}
              </span>
            )}
            {submit.isSuccess && (
              <span className="text-xs text-[#0a7a4f]">saved</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function EvalRunPage() {
  const params = useParams<{ id: string }>();
  const runId = parseInt(params.id ?? "0", 10);
  const me = useMe();
  const isAdmin = me.data?.user.isPlatformAdmin === true;
  const [unblindRequested, setUnblindRequested] = useState(false);
  const unblinded = isAdmin && unblindRequested;
  const qc = useQueryClient();
  const queryKey = ["eval-run", runId, unblinded] as const;
  const { data, isLoading, error } = useQuery<{
    run: EvalRunRow;
    items: EvalItemRow[];
    unblinded: boolean;
  }>({
    queryKey,
    queryFn: () =>
      fetchJson(
        `/api/faculty/evals/runs/${runId}${unblinded ? "?unblinded=1" : ""}`,
      ),
    enabled: Number.isFinite(runId) && runId > 0,
  });
  return (
    <PortalShell>
      <Link
        href="/evals"
        className="text-xs text-[#8C1515] hover:underline"
        data-testid="link-back-to-evals"
      >
        ← All eval runs
      </Link>
      {isLoading && <p className="text-[#8a6a5a] mt-4">Loading…</p>}
      {error && (
        <p className="text-[#E8352A] mt-4">{(error as Error).message}</p>
      )}
      {data && (
        <>
          <div className="flex items-start justify-between gap-4 mt-2 mb-6">
            <div>
              <h1 className="font-serif text-3xl font-medium">
                {data.run.name}
              </h1>
              <p className="text-xs text-[#8a6a5a] mt-1">
                {new Date(data.run.createdAt).toLocaleString()} ·{" "}
                {data.run.targetUrl} · {data.run.completedItems}/
                {data.run.totalItems} items · median{" "}
                {data.run.medianLatencyMs ?? "?"}ms
              </p>
              <div className="text-xs text-[#572020] mt-2 font-mono">
                citation verified {fmtPct(data.run.citationVerifiedRate)} ·
                unmatched {fmtPct(data.run.citationUnmatchedRate)} · missing{" "}
                {fmtPct(data.run.citationMissingRate)}
              </div>
              <div className="text-xs text-[#572020] mt-1 font-mono">
                coverage {fmtPct(data.run.coverageRate)} · refusal{" "}
                {fmtPct(data.run.refusalComplianceRate)} · uncovered honesty{" "}
                {fmtPct(data.run.uncoveredHonestyRate)}
              </div>
            </div>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setUnblindRequested((v) => !v)}
                className="text-xs text-[#8C1515] hover:underline shrink-0"
                data-testid="button-toggle-unblind"
              >
                {unblinded ? "Re-blind" : "Unblind (admin)"}
              </button>
            )}
          </div>
          <div className="grid gap-4">
            {data.items.map((it) => (
              <GradeItemCard
                key={it.id}
                item={it}
                unblinded={unblinded}
                onGraded={() => qc.invalidateQueries({ queryKey })}
              />
            ))}
          </div>
        </>
      )}
    </PortalShell>
  );
}

// ---------- Cross-pillar collaboration (T3 / T4 / T5 / T6) ----------

interface CrossPillarSummary {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  approvedInterpretations: number;
  approvedSources: number;
  // Total uploaded sources regardless of approval status (steward onboarding gate).
  sourceCount: number;
  isMine: boolean;
}

interface CrossPillarInterp {
  id: number;
  answer: string;
  interpretation: string;
  action: string | null;
  tags: string[] | null;
  approvedAt: string | null;
  pillarId: number;
  pillarSlug: string;
  pillarName: string;
  sourceId: number;
  sourceTitle: string;
  sourceAuthors: string | null;
  sourceYear: number | null;
  authorName: string | null;
  isMine: boolean;
}

interface MergeRequest {
  id: number;
  status: "proposed" | "approved" | "declined";
  note: string | null;
  declineReason: string | null;
  createdAt: string;
  reviewedAt: string | null;
  sourceInterpretationId: number;
  sourcePillarId: number;
  targetPillarId: number;
  resultingInterpretationId: number | null;
  interpretationAnswer: string | null;
  sourcePillarName: string | null;
  sourcePillarSlug: string | null;
  requesterName: string | null;
  targetPillarName: string | null;
}

function useCrossPillarSummary() {
  const viewAs = useViewAs();
  return useQuery<{ pillars: CrossPillarSummary[] }>({
    queryKey: ["cross-pillar-pillars", viewAs?.id ?? null],
    queryFn: () => fetchJson("/api/faculty/cross-pillar/pillars"),
  });
}

/**
 * T3 — Post-onboarding "start here" guidance. Shows a concise next-steps
 * sequence to a steward whose pillar has no published answers yet, then
 * de-emphasizes to a single quiet pointer once they've published at least
 * one interpretation (i.e. they're "active").
 */

/**
 * T4 — Cross-pillar browser. Read-only list of every pillar's approved
 * interpretations, filterable by pillar. Each card links to a detail page
 * with discussion (T5) and the adopt/propose flow (T6).
 */
function CrossPillarBrowserBody({ embedded = false }: { embedded?: boolean }) {
  const [pillarFilter, setPillarFilter] = useState<string | null>(null);
  const { data: summary } = useCrossPillarSummary();
  const { data, isLoading, error } = useQuery<{
    interpretations: CrossPillarInterp[];
  }>({
    queryKey: ["cross-pillar-interps", pillarFilter],
    queryFn: () =>
      fetchJson(
        `/api/faculty/cross-pillar/interpretations${
          pillarFilter ? `?pillar=${encodeURIComponent(pillarFilter)}` : ""
        }`,
      ),
  });

  return (
    <>
      {!embedded && (
        <>
          <h1 className="font-serif text-3xl font-medium mb-2">
            Explore pillars
          </h1>
          <p className="text-[#8a6a5a] mb-6 max-w-2xl">
            Every published answer across the platform. Read freely, join the
            discussion, or propose adopting an answer into a pillar you steward.
          </p>
        </>
      )}

      <div className="flex flex-wrap gap-2 mb-8">
        <button
          type="button"
          onClick={() => setPillarFilter(null)}
          className={`text-xs px-3 py-1.5 rounded-full border transition ${
            pillarFilter === null
              ? "border-[#8C1515] text-[#8C1515] bg-[#8C1515]/5"
              : "border-[#E8DDD0] text-[#8a6a5a] hover:border-[#8C1515]"
          }`}
          data-testid="filter-pillar-all"
        >
          All pillars
        </button>
        {(summary?.pillars ?? [])
          .filter((p) => p.approvedInterpretations > 0)
          .map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPillarFilter(p.slug)}
              className={`text-xs px-3 py-1.5 rounded-full border transition ${
                pillarFilter === p.slug
                  ? "border-[#8C1515] text-[#8C1515] bg-[#8C1515]/5"
                  : "border-[#E8DDD0] text-[#8a6a5a] hover:border-[#8C1515]"
              }`}
              data-testid={`filter-pillar-${p.slug}`}
            >
              {p.name}
              {p.isMine ? " ·  yours" : ""} ({p.approvedInterpretations})
            </button>
          ))}
      </div>

      {isLoading && <p className="text-[#8a6a5a]">Loading…</p>}
      {error && (
        <p className="text-[#E8352A]" data-testid="text-error">
          {(error as Error).message}
        </p>
      )}
      {data && data.interpretations.length === 0 && (
        <p className="text-[#8a6a5a]" data-testid="text-empty">
          No published answers here yet.
        </p>
      )}

      <div className="space-y-4">
        {data?.interpretations.map((it) => (
          <Link
            key={it.id}
            href={`/explore/interpretations/${it.id}`}
            className="block border border-[#E8DDD0] hover:border-[#8C1515] rounded-xl p-5 transition"
            data-testid={`card-interp-${it.id}`}
          >
            <div className="flex items-baseline justify-between gap-3 mb-2">
              <span className="text-[10px] tracking-[0.2em] text-[#8C1515] uppercase">
                {it.pillarName}
                {it.isMine ? " · yours" : ""}
              </span>
              {it.authorName && (
                <span className="text-xs text-[#8a6a5a]">{it.authorName}</span>
              )}
            </div>
            <h2 className="font-serif text-lg text-[#572020] mb-1">
              {it.answer}
            </h2>
            <p className="text-sm text-[#8a6a5a] line-clamp-2">
              {it.interpretation}
            </p>
            <p className="text-xs text-[#8a6a5a] mt-3">
              {it.sourceTitle}
              {it.sourceYear ? ` (${it.sourceYear})` : ""}
            </p>
          </Link>
        ))}
      </div>
    </>
  );
}

function CrossPillarBrowser() {
  return (
    <PortalShell>
      <CrossPillarBrowserBody />
    </PortalShell>
  );
}

/**
 * T4 / T5 / T6 — Cross-pillar interpretation detail. Read-only view of one
 * approved interpretation, the cross-steward discussion thread, and (for
 * stewards of other pillars) the "propose to adopt" merge-request flow.
 */
function CrossPillarInterpretationPage() {
  const params = useParams();
  const id = Number(params.id);
  const { data: me } = useMe();
  const qc = useQueryClient();
  const viewAs = useViewAs();
  const { data, isLoading, error } = useQuery<{
    interpretations: CrossPillarInterp[];
  }>({
    queryKey: ["cross-pillar-interps", null],
    queryFn: () => fetchJson(`/api/faculty/cross-pillar/interpretations`),
  });

  const it = data?.interpretations.find((x) => x.id === id);

  const myStewardPillars = (me?.pillars ?? []).filter(
    (p) =>
      me?.memberships.find((m) => m.pillarId === p.id)?.role === "steward" &&
      p.id !== it?.pillarId,
  );
  const [targetPillarId, setTargetPillarId] = useState<number | "">("");
  const [note, setNote] = useState("");

  const propose = useMutation({
    mutationFn: () =>
      fetchJson(`/api/faculty/cross-pillar/merge-requests`, {
        method: "POST",
        body: JSON.stringify({
          sourceInterpretationId: id,
          targetPillarId: Number(targetPillarId),
          note: note.trim() || null,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["merge-requests"] });
      setNote("");
      setTargetPillarId("");
    },
  });

  if (isLoading)
    return (
      <PortalShell>
        <p className="text-[#8a6a5a]">Loading…</p>
      </PortalShell>
    );
  if (error)
    return (
      <PortalShell>
        <p className="text-[#E8352A]" data-testid="text-error">
          {(error as Error).message}
        </p>
      </PortalShell>
    );
  if (!it)
    return (
      <PortalShell>
        <p className="text-[#8a6a5a]" data-testid="text-not-found">
          That answer isn't available.{" "}
          <Link href="/explore" className="text-[#8C1515] hover:underline">
            Back to Explore
          </Link>
        </p>
      </PortalShell>
    );

  return (
    <PortalShell>
      <Link
        href="/explore"
        className="text-xs text-[#8a6a5a] hover:text-[#8C1515]"
        data-testid="link-back-explore"
      >
        ← Explore
      </Link>
      <div className="mt-3 mb-2 flex items-baseline justify-between gap-3">
        <span className="text-[10px] tracking-[0.2em] text-[#8C1515] uppercase">
          {it.pillarName}
          {it.isMine ? " · yours" : ""}
        </span>
        {it.authorName && (
          <span className="text-xs text-[#8a6a5a]">{it.authorName}</span>
        )}
      </div>
      <h1 className="font-serif text-2xl font-medium text-[#572020] mb-4">
        {it.answer}
      </h1>
      <p className="text-sm text-[#572020] leading-relaxed mb-4 whitespace-pre-wrap">
        {it.interpretation}
      </p>
      {it.action && (
        <div className="mb-4 border-l-2 border-[#8C1515] pl-4">
          <p className="text-[10px] tracking-[0.2em] text-[#8C1515] uppercase mb-1">
            Try this
          </p>
          <p className="text-sm text-[#572020]">{it.action}</p>
        </div>
      )}
      <p className="text-xs text-[#8a6a5a] mb-6">
        Source: {it.sourceTitle}
        {it.sourceAuthors ? ` — ${it.sourceAuthors}` : ""}
        {it.sourceYear ? ` (${it.sourceYear})` : ""}
      </p>

      {/* T6 — propose to adopt into a pillar I steward */}
      {!it.isMine && myStewardPillars.length > 0 && (
        <section
          className="mb-6 border border-[#E8DDD0] rounded-xl p-5 bg-[#F9F5EE]"
          data-testid="card-propose"
        >
          <h2 className="font-serif text-lg text-[#572020] mb-1">
            Adopt into your pillar
          </h2>
          <p className="text-sm text-[#8a6a5a] mb-4 max-w-2xl">
            Propose adopting this answer. The owning steward reviews it; on
            approval an attributed copy lands in your pillar, crediting the
            original author.
          </p>
          {propose.isSuccess ? (
            <p className="text-sm text-[#572020]" data-testid="text-proposed">
              Proposal sent — track it under{" "}
              <Link href="/requests" className="text-[#8C1515] hover:underline">
                Requests
              </Link>
              .
            </p>
          ) : (
            <div className="space-y-3">
              <select
                value={targetPillarId}
                onChange={(e) =>
                  setTargetPillarId(
                    e.target.value ? Number(e.target.value) : "",
                  )
                }
                className="w-full border border-[#E8DDD0] rounded px-3 py-2 text-sm bg-white"
                data-testid="select-target-pillar"
              >
                <option value="">Choose a pillar you steward…</option>
                {myStewardPillars.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note for the owning steward…"
                rows={2}
                className="w-full border border-[#E8DDD0] rounded px-3 py-2 text-sm bg-white"
                data-testid="input-propose-note"
              />
              {propose.error && (
                <p
                  className="text-xs text-[#E8352A]"
                  data-testid="text-propose-error"
                >
                  {(propose.error as Error).message}
                </p>
              )}
              <button
                type="button"
                disabled={!targetPillarId || propose.isPending || !!viewAs}
                onClick={() => propose.mutate()}
                className="text-sm bg-[#8C1515] hover:bg-[#a01a1a] disabled:opacity-50 text-white px-4 py-2 rounded transition"
                data-testid="button-propose"
              >
                {propose.isPending ? "Sending…" : "Propose adoption"}
              </button>
            </div>
          )}
        </section>
      )}

      {/* T5 — cross-steward discussion */}
      <InterpretationDiscussion
        interpretationId={it.id}
        pillarName={it.pillarName}
      />
    </PortalShell>
  );
}

/**
 * T6 — Merge requests inbox/outbox. Inbox: requests to adopt MY pillars'
 * answers (I approve/decline). Outbox: requests I've opened elsewhere.
 */
function MergeRequestsBody({ embedded = false }: { embedded?: boolean }) {
  const [box, setBox] = useState<"inbox" | "outbox">("inbox");
  const qc = useQueryClient();
  const viewAs = useViewAs();
  const { data, isLoading, error } = useQuery<{ requests: MergeRequest[] }>({
    queryKey: ["merge-requests", box],
    queryFn: () =>
      fetchJson(`/api/faculty/cross-pillar/merge-requests?box=${box}`),
  });

  const approve = useMutation({
    mutationFn: (rid: number) =>
      fetchJson(`/api/faculty/cross-pillar/merge-requests/${rid}/approve`, {
        method: "POST",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["merge-requests"] }),
  });
  const decline = useMutation({
    mutationFn: (rid: number) =>
      fetchJson(`/api/faculty/cross-pillar/merge-requests/${rid}/decline`, {
        method: "POST",
        body: JSON.stringify({ reason: null }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["merge-requests"] }),
  });

  const statusPill = (s: MergeRequest["status"]) => {
    const map: Record<MergeRequest["status"], string> = {
      proposed: "text-[#8C1515] border-[#8C1515]",
      approved: "text-[#1f7a3d] border-[#1f7a3d]",
      declined: "text-[#8a6a5a] border-[#E8DDD0]",
    };
    return (
      <span
        className={`text-[10px] tracking-[0.15em] uppercase px-2 py-0.5 rounded-full border ${map[s]}`}
      >
        {s}
      </span>
    );
  };

  return (
    <>
      {!embedded && (
        <>
          <h1 className="font-serif text-3xl font-medium mb-2">
            Merge requests
          </h1>
          <p className="text-[#8a6a5a] mb-6 max-w-2xl">
            Pull requests for science — adopt one pillar's published answer into
            another, with the owning steward's sign-off.
          </p>
        </>
      )}

      <div className="flex gap-2 mb-8">
        {(["inbox", "outbox"] as const).map((b) => (
          <button
            key={b}
            type="button"
            onClick={() => setBox(b)}
            className={`text-xs px-3 py-1.5 rounded-full border transition capitalize ${
              box === b
                ? "border-[#8C1515] text-[#8C1515] bg-[#8C1515]/5"
                : "border-[#E8DDD0] text-[#8a6a5a] hover:border-[#8C1515]"
            }`}
            data-testid={`tab-${b}`}
          >
            {b === "inbox" ? "To review" : "Mine"}
          </button>
        ))}
      </div>

      {isLoading && <p className="text-[#8a6a5a]">Loading…</p>}
      {error && (
        <p className="text-[#E8352A]" data-testid="text-error">
          {(error as Error).message}
        </p>
      )}
      {data && data.requests.length === 0 && (
        <p className="text-[#8a6a5a]" data-testid="text-empty">
          {box === "inbox"
            ? "No one has proposed adopting your answers yet."
            : "You haven't proposed any adoptions yet."}
        </p>
      )}

      <div className="space-y-4">
        {data?.requests.map((r) => (
          <div
            key={r.id}
            className="border border-[#E8DDD0] rounded-xl p-5"
            data-testid={`merge-request-${r.id}`}
          >
            <div className="flex items-baseline justify-between gap-3 mb-2">
              <span className="text-xs text-[#8a6a5a]">
                {r.sourcePillarName ?? "—"} → {r.targetPillarName ?? "—"}
              </span>
              {statusPill(r.status)}
            </div>
            {r.interpretationAnswer && (
              <p className="font-serif text-base text-[#572020] mb-1">
                {r.interpretationAnswer}
              </p>
            )}
            <p className="text-xs text-[#8a6a5a] mb-1">
              Proposed by {r.requesterName ?? "a steward"} ·{" "}
              {new Date(r.createdAt).toLocaleDateString()}
            </p>
            {r.note && (
              <p className="text-sm text-[#572020] mt-2 border-l-2 border-[#E8DDD0] pl-3">
                {r.note}
              </p>
            )}
            {r.status === "declined" && r.declineReason && (
              <p className="text-xs text-[#8a6a5a] mt-2">
                Declined: {r.declineReason}
              </p>
            )}
            {box === "inbox" && r.status === "proposed" && (
              <div className="flex gap-2 mt-4">
                <button
                  type="button"
                  disabled={approve.isPending || !!viewAs}
                  onClick={() => approve.mutate(r.id)}
                  className="text-sm bg-[#8C1515] hover:bg-[#a01a1a] disabled:opacity-50 text-white px-4 py-2 rounded transition"
                  data-testid={`button-approve-${r.id}`}
                >
                  Approve & adopt
                </button>
                <button
                  type="button"
                  disabled={decline.isPending || !!viewAs}
                  onClick={() => decline.mutate(r.id)}
                  className="text-sm border border-[#E8DDD0] hover:border-[#8C1515] disabled:opacity-50 text-[#572020] px-4 py-2 rounded transition"
                  data-testid={`button-decline-${r.id}`}
                >
                  Decline
                </button>
              </div>
            )}
            {box === "outbox" &&
              r.status === "approved" &&
              r.resultingInterpretationId && (
                <p className="text-xs text-[#1f7a3d] mt-3">
                  Adopted into {r.targetPillarName ?? "your pillar"}.
                </p>
              )}
          </div>
        ))}
      </div>
    </>
  );
}

function MergeRequestsPage() {
  return (
    <PortalShell>
      <MergeRequestsBody />
    </PortalShell>
  );
}

// ---------- Quick Answer ----------

interface QuickAnswerResponse {
  ok: boolean;
  reason?: string;
  aiAvailable?: boolean;
  hasVoiceProfile?: boolean;
  question?: string;
  source?: { id: number; title: string };
  suggestions: Array<{ sourceId: number; title: string; score: number }>;
  draft?: {
    answer: string;
    interpretation: string;
    notProven: string | null;
    action: string | null;
  } | null;
  aiDraft?: string;
  chunks?: Array<{ chunkIndex: number; text: string }>;
  usedChunks?: number;
}

function qaInitialParam(name: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

function QuickAnswerPage() {
  const { data: me } = useMe();
  const [, setLocation] = useLocation();

  // Pillars the caller may steward or contribute to (admins see all).
  const eligible = useMemo(() => {
    if (!me)
      return [] as Array<{ slug: string; name: string; canApprove: boolean }>;
    return me.pillars
      .map((p) => {
        const m = me.memberships.find((mm) => mm.pillarId === p.id);
        const role = m?.role ?? null;
        const canApprove = me.user.isPlatformAdmin || role === "steward";
        const canUse =
          me.user.isPlatformAdmin ||
          role === "steward" ||
          role === "contributor";
        return { slug: p.slug, name: p.name, canApprove, canUse };
      })
      .filter((p) => p.canUse)
      .map((p) => ({ slug: p.slug, name: p.name, canApprove: p.canApprove }));
  }, [me]);

  const [slug, setSlug] = useState<string>("");
  // Pick the slug from ?slug= (if eligible) else the first eligible pillar,
  // once `me` has loaded.
  useEffect(() => {
    if (slug || eligible.length === 0) return;
    const wanted = qaInitialParam("slug");
    const match = eligible.find((p) => p.slug === wanted);
    setSlug(match ? match.slug : eligible[0]!.slug);
  }, [eligible, slug]);

  const current = eligible.find((p) => p.slug === slug) ?? null;
  const canApprove = current?.canApprove ?? false;

  const [question, setQuestion] = useState<string>(() => qaInitialParam("q"));
  const [phase, setPhase] = useState<"ask" | "review">("ask");
  const [result, setResult] = useState<QuickAnswerResponse | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<InterpretationDraft>(EMPTY_DRAFT);
  const [aiDraft, setAiDraft] = useState<string>("");
  const [groundSourceId, setGroundSourceId] = useState<number | null>(null);
  const [createdId, setCreatedId] = useState<number | null>(null);
  const [busy, setBusy] = useState<null | "approve" | "hand" | "refine">(null);
  const [done, setDone] = useState<null | "approved" | "handed">(null);

  // Reader-demand questions for the picked pillar.
  const dash = useQuery<CoverageDashboardData>({
    queryKey: ["faculty-dashboard", slug],
    queryFn: () => fetchJson(`/api/faculty/pillars/${slug}/dashboard`),
    enabled: !!slug,
  });
  // The complete windowed backlog for this pillar: clustered (promotable)
  // demand AND still-ungrouped "just came in" questions, so the steward sees
  // the same honest set the Unanswered (Gaps) page shows — not just a thin
  // slice of clusters. Most-asked first; clicking any drops it into the box.
  const demand = useMemo(() => {
    const g = dash.data?.gaps;
    if (!g) return [] as Array<{ key: string; text: string; count: number }>;
    const clustered = g.clusters.map((c) => ({
      key: `c-${c.id}`,
      text: c.representativeQuestion,
      count: c.askedInWindow,
    }));
    const fresh = g.ungroupedUncovered.map((u, i) => ({
      key: `u-${i}`,
      text: u.question,
      count: u.count,
    }));
    return [...clustered, ...fresh]
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
  }, [dash.data]);

  async function runDraft(sourceId?: number): Promise<void> {
    const q = question.trim();
    if (!q || !slug) return;
    setError(null);
    setDrafting(true);
    setCreatedId(null);
    setDone(null);
    try {
      const r = await fetchJson<QuickAnswerResponse>(
        `/api/faculty/pillars/${slug}/quick-answer/draft`,
        {
          method: "POST",
          body: JSON.stringify({
            question: q,
            ...(sourceId ? { sourceId } : {}),
          }),
        },
      );
      setResult(r);
      if (r.ok && r.draft) {
        setForm({
          answer: r.draft.answer,
          interpretation: r.draft.interpretation,
          notProven: r.draft.notProven ?? "",
          action: r.draft.action ?? "",
          tagsInput: "",
        });
        setAiDraft(r.aiDraft ?? r.draft.interpretation);
        setGroundSourceId(r.source?.id ?? null);
        setPhase("review");
      } else if (r.ok && !r.draft) {
        // AI unavailable or empty retrieval — show the review screen with a
        // graceful message + a path into the full editor.
        setForm({
          answer: r.question ?? q,
          interpretation: "",
          notProven: "",
          action: "",
          tagsInput: "",
        });
        setAiDraft("");
        setGroundSourceId(r.source?.id ?? null);
        setPhase("review");
      } else {
        // ok:false (no source in the pillar) — stay on the ask screen and
        // offer to upload one.
        setPhase("ask");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDrafting(false);
    }
  }

  // Create the interpretation row exactly once; reuse it (PATCH) for any
  // later finish action so the quick flow and the full editor always act on
  // the same row — no duplicates, no orphans.
  async function materialize(): Promise<number> {
    const answer = form.answer.trim();
    const interpretation = form.interpretation.trim();
    if (!answer) throw new Error("Add a one-sentence headline answer first.");
    if (!interpretation)
      throw new Error("Write the plain-language answer first.");
    if (!groundSourceId) throw new Error("No grounding source selected.");
    const body = {
      answer,
      interpretation,
      notProven: form.notProven.trim() || null,
      action: form.action.trim() || null,
      tags: form.tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      ...(aiDraft ? { aiDraft } : {}),
    };
    if (createdId != null) {
      await fetchJson(`/api/faculty/interpretations/${createdId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      return createdId;
    }
    const created = await fetchJson<{ id: number }>(
      `/api/faculty/sources/${groundSourceId}/interpretations`,
      { method: "POST", body: JSON.stringify(body) },
    );
    setCreatedId(created.id);
    return created.id;
  }

  async function approve(): Promise<void> {
    setBusy("approve");
    setError(null);
    try {
      const id = await materialize();
      await fetchJson(`/api/faculty/interpretations/${id}/transition`, {
        method: "POST",
        body: JSON.stringify({ status: "approved" }),
      });
      setDone("approved");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handToTeam(): Promise<void> {
    setBusy("hand");
    setError(null);
    try {
      await materialize();
      setDone("handed");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function refine(): Promise<void> {
    setBusy("refine");
    setError(null);
    try {
      const id = await materialize();
      setLocation(`/pillars/${slug}/sources/${groundSourceId}?interp=${id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  function reset(): void {
    setPhase("ask");
    setResult(null);
    setForm(EMPTY_DRAFT);
    setAiDraft("");
    setGroundSourceId(null);
    setCreatedId(null);
    setDone(null);
    setError(null);
    setQuestion("");
  }

  if (!me) {
    return (
      <PortalShell>
        <p className="text-[#8a6a5a]">Loading…</p>
      </PortalShell>
    );
  }

  if (eligible.length === 0) {
    return (
      <PortalShell>
        <div className="max-w-xl">
          <h1 className="font-serif text-3xl font-medium mb-3">Quick answer</h1>
          <p className="text-[#8a6a5a] leading-relaxed">
            You need to steward or contribute to a pillar to draft answers. A
            steward will need to add you to one first.
          </p>
        </div>
      </PortalShell>
    );
  }

  return (
    <PortalShell>
      <div className="max-w-3xl mx-auto">
        <div className="flex items-baseline justify-between gap-4 mb-1">
          <h1 className="font-serif text-3xl font-medium">Quick answer</h1>
          {eligible.length > 1 && (
            <select
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                reset();
              }}
              className="rounded border border-[#E8DDD0] bg-white px-2 py-1 text-sm"
              data-testid="select-quick-answer-pillar"
            >
              {eligible.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <p className="text-[#8a6a5a] leading-relaxed mb-8">
          Answer a reader's question in one screen — grounded in your library,
          drafted in your voice, ready to publish or hand to a teammate.
        </p>

        {done ? (
          <QuickAnswerDone
            kind={done}
            slug={slug}
            sourceId={groundSourceId}
            onAnother={reset}
          />
        ) : phase === "ask" ? (
          <div className="space-y-6">
            <div>
              <label
                htmlFor="qa-question"
                className="block text-sm font-medium mb-2"
              >
                What do you want to answer?
              </label>
              <textarea
                id="qa-question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                rows={3}
                placeholder="e.g. Does melatonin actually help you fall asleep faster?"
                className="w-full rounded-lg border border-[#E8DDD0] bg-white px-3 py-2 text-[#572020] focus:outline-none focus:ring-2 focus:ring-[#8C1515]/30"
                data-testid="input-quick-answer-question"
              />
            </div>

            {result?.ok === false && result.reason === "no_source" ? (
              <QuickAnswerUploadOffer
                slug={slug}
                onUploaded={(id) => runDraft(id)}
              />
            ) : null}

            <div>
              <div className="flex items-baseline justify-between gap-3 mb-2">
                <p className="text-xs uppercase tracking-[0.18em] text-[#8a6a5a]">
                  Readers are asking
                </p>
                {slug && (
                  <Link
                    href={`/gaps?slug=${encodeURIComponent(slug)}`}
                    className="text-xs font-medium text-[#8C1515] hover:underline whitespace-nowrap"
                    data-testid="link-see-all-unanswered"
                  >
                    See all unanswered →
                  </Link>
                )}
              </div>
              {demand.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {demand.map((d) => (
                    <button
                      key={d.key}
                      type="button"
                      onClick={() => setQuestion(d.text)}
                      className="rounded-full border border-[#E8DDD0] bg-white px-3 py-1.5 text-xs text-left text-[#572020] hover:border-[#8C1515] hover:text-[#8C1515] transition"
                      data-testid={`chip-demand-${d.key}`}
                    >
                      {d.text}
                      <span className="ml-1 text-[#8a6a5a]">· {d.count}×</span>
                    </button>
                  ))}
                </div>
              ) : dash.isLoading ? (
                <p className="text-xs text-[#8a6a5a]">Loading…</p>
              ) : (
                <p
                  className="text-xs text-[#8a6a5a]"
                  data-testid="text-no-demand"
                >
                  No unanswered questions right now.
                </p>
              )}
            </div>

            {error && (
              <p className="text-sm text-[#E8352A]" data-testid="text-qa-error">
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={() => runDraft()}
              disabled={!question.trim() || drafting}
              className="rounded-full bg-[#8C1515] px-7 py-3 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[#a01a1a] disabled:opacity-50"
              data-testid="button-draft-answer"
            >
              {drafting ? "Drafting…" : "Draft my answer →"}
            </button>
          </div>
        ) : (
          <QuickAnswerReview
            result={result}
            form={form}
            setForm={setForm}
            canApprove={canApprove}
            busy={busy}
            error={error}
            onApprove={approve}
            onHand={handToTeam}
            onRefine={refine}
            onReground={(id) => runDraft(id)}
            onBack={() => {
              setPhase("ask");
              setError(null);
            }}
          />
        )}
      </div>
    </PortalShell>
  );
}

function QuickAnswerField({
  label,
  hint,
  value,
  onChange,
  rows,
  testId,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  rows: number;
  testId: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium">{label}</label>
      {hint && <p className="text-xs text-[#8a6a5a] mb-1">{hint}</p>}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="mt-1 w-full rounded-lg border border-[#E8DDD0] bg-white px-3 py-2 text-[#572020] focus:outline-none focus:ring-2 focus:ring-[#8C1515]/30"
        data-testid={testId}
      />
    </div>
  );
}

function QuickAnswerReview({
  result,
  form,
  setForm,
  canApprove,
  busy,
  error,
  onApprove,
  onHand,
  onRefine,
  onReground,
  onBack,
}: {
  result: QuickAnswerResponse | null;
  form: InterpretationDraft;
  setForm: React.Dispatch<React.SetStateAction<InterpretationDraft>>;
  canApprove: boolean;
  busy: null | "approve" | "hand" | "refine";
  error: string | null;
  onApprove: () => void;
  onHand: () => void;
  onRefine: () => void;
  onReground: (sourceId: number) => void;
  onBack: () => void;
}) {
  const aiUnavailable = result?.aiAvailable === false;
  const emptyRetrieval =
    result?.ok === true && result.reason === "empty_retrieval";
  const suggestions = result?.suggestions ?? [];

  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={onBack}
        className="text-sm text-[#8a6a5a] hover:text-[#8C1515]"
        data-testid="button-qa-back"
      >
        ← Edit the question
      </button>

      {/* Unobtrusive grounding line */}
      {result?.source && (
        <div className="text-xs text-[#8a6a5a]">
          Grounded in{" "}
          <span className="text-[#572020] font-medium">
            {result.source.title}
          </span>
          {typeof result.usedChunks === "number" && result.usedChunks > 0 && (
            <>
              {" "}
              · {result.usedChunks} passage{result.usedChunks === 1 ? "" : "s"}
            </>
          )}
          {suggestions.length > 1 && (
            <div className="mt-1 flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button
                  key={s.sourceId}
                  type="button"
                  onClick={() => onReground(s.sourceId)}
                  className={`rounded-full border px-2 py-0.5 text-[11px] transition ${
                    s.sourceId === result.source?.id
                      ? "border-[#8C1515] text-[#8C1515]"
                      : "border-[#E8DDD0] text-[#8a6a5a] hover:border-[#8C1515]"
                  }`}
                  data-testid={`button-reground-${s.sourceId}`}
                >
                  {s.title}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {result?.hasVoiceProfile === false && (
        <p className="rounded-lg bg-[#F9F5EE] border border-[#E8DDD0] px-3 py-2 text-xs text-[#8a6a5a]">
          Drafted in a neutral voice.{" "}
          <Link href="/voice" className="text-[#8C1515] underline">
            Set up your voice profile
          </Link>{" "}
          to make it sound like you.
        </p>
      )}

      {aiUnavailable && (
        <p
          className="rounded-lg bg-[#F9F5EE] border border-[#E8DDD0] px-3 py-2 text-sm text-[#572020]"
          data-testid="text-qa-ai-unavailable"
        >
          The AI drafter isn't available right now. You can still write this
          answer yourself — fill in the headline and answer below, then open the
          full editor.
        </p>
      )}

      {emptyRetrieval && (
        <p className="rounded-lg bg-[#F9F5EE] border border-[#E8DDD0] px-3 py-2 text-sm text-[#572020]">
          That source didn't have passages close enough to draft from. Try a
          different grounding above, or refine the question.
        </p>
      )}

      <div className="space-y-4 rounded-xl border border-[#E8DDD0] bg-white p-5">
        <QuickAnswerField
          label="Headline answer"
          hint="One sentence the reader sees first."
          value={form.answer}
          onChange={(v) => setForm((f) => ({ ...f, answer: v }))}
          rows={2}
          testId="input-qa-answer"
        />
        <QuickAnswerField
          label="Plain-language reading"
          hint="2–4 sentences explaining what the source shows."
          value={form.interpretation}
          onChange={(v) => setForm((f) => ({ ...f, interpretation: v }))}
          rows={5}
          testId="input-qa-interpretation"
        />
        <QuickAnswerField
          label="What it doesn't prove"
          hint="Optional — the honest limit of this source."
          value={form.notProven}
          onChange={(v) => setForm((f) => ({ ...f, notProven: v }))}
          rows={2}
          testId="input-qa-notproven"
        />
        <QuickAnswerField
          label="Suggested action"
          hint="Optional — one practical next step for the reader."
          value={form.action}
          onChange={(v) => setForm((f) => ({ ...f, action: v }))}
          rows={2}
          testId="input-qa-action"
        />
      </div>

      {error && (
        <p
          className="text-sm text-[#E8352A]"
          data-testid="text-qa-review-error"
        >
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {canApprove && (
          <button
            type="button"
            onClick={onApprove}
            disabled={busy !== null}
            className="rounded-full bg-[#8C1515] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#a01a1a] disabled:opacity-50"
            data-testid="button-qa-approve"
          >
            {busy === "approve" ? "Publishing…" : "Approve & publish"}
          </button>
        )}
        <button
          type="button"
          onClick={onHand}
          disabled={busy !== null}
          className="rounded-full border border-[#8C1515] px-6 py-2.5 text-sm font-medium text-[#8C1515] transition-colors hover:bg-[#8C1515]/5 disabled:opacity-50"
          data-testid="button-qa-hand"
        >
          {busy === "hand"
            ? "Sending…"
            : canApprove
              ? "Hand to a teammate"
              : "Send to steward for review"}
        </button>
        <button
          type="button"
          onClick={onRefine}
          disabled={busy !== null}
          className="text-sm text-[#8a6a5a] hover:text-[#8C1515] disabled:opacity-50"
          data-testid="button-qa-refine"
        >
          {busy === "refine" ? "Opening…" : "Refine in full editor →"}
        </button>
      </div>
    </div>
  );
}

function QuickAnswerDone({
  kind,
  slug,
  sourceId,
  onAnother,
}: {
  kind: "approved" | "handed";
  slug: string;
  sourceId: number | null;
  onAnother: () => void;
}) {
  return (
    <div
      className="rounded-xl border border-[#E8DDD0] bg-white p-6"
      data-testid="text-qa-done"
    >
      <h2 className="font-serif text-2xl mb-2">
        {kind === "approved" ? "Published." : "Handed off for review."}
      </h2>
      <p className="text-[#8a6a5a] leading-relaxed mb-5">
        {kind === "approved"
          ? "Your answer is approved and live in this pillar's library."
          : "Your draft is in the steward inbox as a proposed answer. A steward can review and approve it."}
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onAnother}
          className="rounded-full bg-[#8C1515] px-6 py-2.5 text-sm font-medium text-white hover:bg-[#a01a1a]"
          data-testid="button-qa-another"
        >
          Answer another
        </button>
        {sourceId != null && (
          <Link
            href={`/pillars/${slug}/sources/${sourceId}`}
            className="rounded-full border border-[#E8DDD0] px-6 py-2.5 text-sm text-[#572020] hover:border-[#8C1515]"
            data-testid="link-qa-source"
          >
            View the source
          </Link>
        )}
        {kind === "handed" && (
          <Link
            href={`/pillars/${slug}/inbox`}
            className="rounded-full border border-[#E8DDD0] px-6 py-2.5 text-sm text-[#572020] hover:border-[#8C1515]"
            data-testid="link-qa-inbox"
          >
            Open the inbox
          </Link>
        )}
      </div>
    </div>
  );
}

function QuickAnswerUploadOffer({
  slug,
  onUploaded,
}: {
  slug: string;
  onUploaded: (sourceId: number) => void;
}) {
  const [kind, setKind] = useState<"paper" | "slm_article" | "talk" | "note">(
    "note",
  );
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(): Promise<void> {
    setError(null);
    if (!file && !text.trim()) {
      setError("Attach a PDF or paste text from the source.");
      return;
    }
    if (!title.trim() && !file) {
      setError("Add a title.");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("kind", kind);
      if (title.trim()) fd.append("title", title.trim());
      if (file) fd.append("file", file);
      if (text.trim()) fd.append("text", text.trim());
      const res = await fetch(`/api/faculty/pillars/${slug}/sources`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) {
        throw new Error((await res.text()) || `Upload failed (${res.status})`);
      }
      const created = (await res.json()) as { id: number };
      onUploaded(created.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="rounded-xl border border-[#E8DDD0] bg-[#F9F5EE] p-4 space-y-3">
      <p className="text-sm text-[#572020]">
        Nothing in your library matches this yet. Add a source to ground your
        answer.
      </p>
      <select
        value={kind}
        onChange={(e) =>
          setKind(e.target.value as "paper" | "slm_article" | "talk" | "note")
        }
        className="rounded border border-[#E8DDD0] bg-white px-2 py-1 text-sm"
        data-testid="select-qa-upload-kind"
      >
        <option value="note">Note</option>
        <option value="paper">Paper</option>
        <option value="slm_article">SLM article</option>
        <option value="talk">Talk or transcript</option>
      </select>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        className="w-full rounded border border-[#E8DDD0] bg-white px-2 py-1 text-sm"
        data-testid="input-qa-upload-title"
      />
      <input
        type="file"
        accept="application/pdf"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="block text-sm"
        data-testid="input-qa-upload-file"
      />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="…or paste the source text"
        className="w-full rounded border border-[#E8DDD0] bg-white px-2 py-1 text-sm"
        data-testid="input-qa-upload-text"
      />
      {error && <p className="text-sm text-[#E8352A]">{error}</p>}
      <button
        type="button"
        onClick={upload}
        disabled={uploading}
        className="rounded-full bg-[#8C1515] px-5 py-2 text-sm font-medium text-white hover:bg-[#a01a1a] disabled:opacity-50"
        data-testid="button-qa-upload"
      >
        {uploading ? "Adding…" : "Add source & draft"}
      </button>
    </div>
  );
}

// ---------- "How AI sees you" — steward AI-visibility report ----------
// One-page report: what ChatGPT/Claude answer today for the steward's
// topics, whether the steward is named, how they are characterized, and who
// gets recommended instead. Reports are generated server-side (bounded,
// cached) and stored; admins can also run prospect reports for recruiting.

interface AiVisSummary {
  mentionedCount: number;
  totalAnswers: number;
  overall: string | null;
  topRecommended: string[];
}
interface AiVisReportListItem {
  id: number;
  subjectName: string;
  topics: string[];
  pillarId: number | null;
  isProspect: boolean;
  status: string;
  createdAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  summary: AiVisSummary | null;
}
interface AiVisEngineAnswer {
  engine: string;
  model: string;
  status: string;
  answerText: string | null;
  errorMessage: string | null;
  mentioned: boolean;
  mentionHits: string[];
  characterization: string | null;
  recommendedInstead: string[];
}
interface AiVisReportDetail extends AiVisReportListItem {
  aliases: string[];
  approvedSources: number;
  payload: {
    questions: string[];
    results: { question: string; engines: AiVisEngineAnswer[] }[];
    summary: AiVisSummary;
  } | null;
}

const AIVIS_ENGINE_LABEL: Record<string, string> = {
  openai: "ChatGPT (OpenAI)",
  anthropic: "Claude (Anthropic)",
};

function AiVisAnswerCard({ a }: { a: AiVisEngineAnswer }) {
  const [open, setOpen] = useState(false);
  const text = a.answerText ?? "";
  const excerpt = text.length > 420 && !open ? text.slice(0, 420) + "…" : text;
  return (
    <div className="rounded-xl border border-[#E8DDD0] bg-white p-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs font-semibold tracking-wide text-[#8a6a5a] uppercase">
          {AIVIS_ENGINE_LABEL[a.engine] ?? a.engine}
        </span>
        {a.status === "ok" ? (
          a.mentioned ? (
            <span className="text-xs font-semibold rounded-full bg-[#e7f2e4] text-[#2e6b2e] px-2.5 py-0.5">
              Mentions you
              {a.mentionHits.length > 0 ? ` (“${a.mentionHits[0]}”)` : ""}
            </span>
          ) : (
            <span className="text-xs font-semibold rounded-full bg-[#f7e8e6] text-[#8C1515] px-2.5 py-0.5">
              You are not mentioned
            </span>
          )
        ) : (
          <span className="text-xs font-semibold rounded-full bg-[#f0ede6] text-[#8a6a5a] px-2.5 py-0.5">
            No answer collected
          </span>
        )}
      </div>
      {a.status === "ok" ? (
        <>
          <p className="mt-3 text-sm leading-relaxed text-[#572020] whitespace-pre-wrap">
            {excerpt}
          </p>
          {text.length > 420 && (
            <button
              className="mt-1 text-xs font-medium text-[#8C1515] hover:text-[#a01a1a]"
              onClick={() => setOpen((v) => !v)}
              data-testid="button-aivis-toggle-answer"
            >
              {open ? "Show less" : "Show full answer"}
            </button>
          )}
          {a.characterization && (
            <p className="mt-3 text-sm text-[#572020]">
              <span className="font-semibold">How it describes you:</span>{" "}
              {a.characterization}
            </p>
          )}
          {a.recommendedInstead.length > 0 && (
            <p className="mt-2 text-sm text-[#8a6a5a]">
              <span className="font-semibold text-[#572020]">
                Who it points people to:
              </span>{" "}
              {a.recommendedInstead.join(", ")}
            </p>
          )}
          <p className="mt-3 text-[11px] text-[#b09a8a]">
            Third-party AI answer, quoted for analysis — not a governed answer.
          </p>
        </>
      ) : (
        <p className="mt-3 text-sm text-[#8a6a5a]">
          {a.errorMessage ?? "The assistant did not answer."}
        </p>
      )}
    </div>
  );
}

function AiVisReportView({ id }: { id: number }) {
  const { data: me } = useMe();
  const query = useQuery<{ report: AiVisReportDetail }>({
    queryKey: ["aivis-report", id],
    queryFn: () => fetchJson(`/api/faculty/ai-visibility/reports/${id}`),
    refetchInterval: (q) =>
      q.state.data?.report.status === "running" ? 4000 : false,
  });
  const report = query.data?.report;
  if (!report) {
    return <p className="text-sm text-[#8a6a5a] mt-6">Loading report…</p>;
  }
  if (report.status === "running") {
    return (
      <div className="mt-6 rounded-xl border border-[#E8DDD0] bg-white p-6">
        <p className="text-sm text-[#572020]">
          Asking the leading AI assistants about {report.subjectName}'s topics…
          this usually takes about a minute. The page refreshes itself.
        </p>
      </div>
    );
  }
  if (report.status === "failed" || !report.payload) {
    return (
      <div className="mt-6 rounded-xl border border-[#E8DDD0] bg-white p-6">
        <p className="text-sm text-[#8C1515]">
          This run failed
          {report.errorMessage ? `: ${report.errorMessage}` : "."} Try
          generating it again.
        </p>
      </div>
    );
  }
  const s = report.payload.summary;
  const pillar = me?.pillars.find((p) => p.id === report.pillarId);
  return (
    <div className="mt-6 space-y-6" data-testid="section-aivis-report">
      <div className="rounded-xl border border-[#E8DDD0] bg-white p-6">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <h2 className="font-serif text-xl text-[#572020]">
            How AI sees {report.subjectName}
          </h2>
          <span className="text-xs text-[#8a6a5a]">
            Snapshot taken{" "}
            {new Date(
              report.completedAt ?? report.createdAt,
            ).toLocaleDateString()}
          </span>
        </div>
        <p className="mt-2 text-sm text-[#8a6a5a]">
          Topics: {report.topics.join(" · ")}
        </p>
        <div className="mt-4 flex items-center gap-3">
          <span
            className="text-3xl font-serif text-[#8C1515]"
            data-testid="text-aivis-mention-rate"
          >
            {s.mentionedCount}/{s.totalAnswers}
          </span>
          <span className="text-sm text-[#572020]">
            AI answers on your topics mention {report.subjectName} today.
          </span>
        </div>
        {s.overall && (
          <p className="mt-4 text-sm leading-relaxed text-[#572020]">
            {s.overall}
          </p>
        )}
        {s.topRecommended.length > 0 && (
          <p className="mt-3 text-sm text-[#8a6a5a]">
            <span className="font-semibold text-[#572020]">
              Who AI recommends on these topics right now:
            </span>{" "}
            {s.topRecommended.join(", ")}
          </p>
        )}
        {report.approvedSources > 0 && pillar ? (
          <div className="mt-4 rounded-lg bg-[#F4ECDD] p-4 text-sm text-[#572020]">
            The after-picture: your pillar already has {report.approvedSources}{" "}
            approved source{report.approvedSources === 1 ? "" : "s"}, so the system
            answers these questions from your own reviewed work, cited and
            signed with your name.{" "}
            <Link
              href={`/pillars/${pillar.slug}/library`}
              className="font-semibold text-[#8C1515] hover:text-[#a01a1a]"
            >
              Open your pillar →
            </Link>
          </div>
        ) : (
          <div className="mt-4 rounded-lg bg-[#F4ECDD] p-4 text-sm text-[#572020]">
            The after-picture: once a pillar carries approved sources, Palonur
            answers these questions from the expert's own reviewed work — cited,
            signed, and under their control.
          </div>
        )}
      </div>
      {report.payload.results.map((r, i) => (
        <div key={i}>
          <h3 className="font-serif text-lg text-[#572020] mb-3">
            “{r.question}”
          </h3>
          <div className="grid gap-3 md:grid-cols-2">
            {r.engines.map((a, j) => (
              <AiVisAnswerCard key={j} a={a} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function AiVisibilityPage() {
  const { data: me } = useMe();
  const isAdmin = !!me?.user.isPlatformAdmin;
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prospect, setProspect] = useState({
    name: "",
    aliases: "",
    topics: "",
  });
  const [showProspect, setShowProspect] = useState(false);

  const listQuery = useQuery<{
    reports: AiVisReportListItem[];
    isAdmin: boolean;
  }>({
    queryKey: ["aivis-reports"],
    queryFn: () => fetchJson("/api/faculty/ai-visibility/reports"),
    refetchInterval: (q) =>
      q.state.data?.reports.some((r) => r.status === "running") ? 5000 : false,
  });
  const reports = listQuery.data?.reports ?? [];

  const generate = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      fetchJson<{ report?: AiVisReportListItem; error?: string }>(
        "/api/faculty/ai-visibility/reports",
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: (data) => {
      setError(null);
      if (data.report) setSelectedId(data.report.id);
      queryClient.invalidateQueries({ queryKey: ["aivis-reports"] });
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : "Could not start the report."),
  });

  const isSteward = (me?.memberships ?? []).some((m) => m.role === "steward");
  const activeId = selectedId ?? reports[0]?.id ?? null;

  return (
    <PortalShell>
      <div className="max-w-4xl mx-auto px-6 py-10">
        <p className="text-[10px] tracking-[0.25em] uppercase text-[#8C1515] font-semibold">
          Before &amp; after
        </p>
        <h1 className="font-serif text-3xl text-[#572020] mt-2">
          How AI sees you
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-[#8a6a5a] max-w-2xl">
          We ask the leading AI assistants a handful of realistic questions from
          your topics and check what comes back: whether you are named, how you
          are described, and who gets recommended instead. That is the
          before-picture. Your governed pillar is the after.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          {(isSteward || isAdmin) && (
            <button
              onClick={() => generate.mutate({})}
              disabled={generate.isPending}
              className="rounded-full bg-[#8C1515] hover:bg-[#a01a1a] text-white text-sm font-semibold px-5 py-2.5 transition disabled:opacity-50"
              data-testid="button-aivis-generate"
            >
              {generate.isPending ? "Starting…" : "Generate my report"}
            </button>
          )}
          {isAdmin && (
            <button
              onClick={() => setShowProspect((v) => !v)}
              className="rounded-full border border-[#E8DDD0] bg-white text-sm font-medium text-[#572020] px-5 py-2.5 hover:bg-[#F9F5EE] transition"
              data-testid="button-aivis-prospect-toggle"
            >
              Report for a prospective steward
            </button>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-[#8C1515]">{error}</p>}

        {isAdmin && showProspect && (
          <form
            className="mt-4 rounded-xl border border-[#E8DDD0] bg-white p-5 space-y-3 max-w-xl"
            onSubmit={(e) => {
              e.preventDefault();
              const topics = prospect.topics
                .split(/[,\n;]/)
                .map((t) => t.trim())
                .filter(Boolean)
                .slice(0, 8);
              const aliases = prospect.aliases
                .split(/[,\n;]/)
                .map((t) => t.trim())
                .filter(Boolean)
                .slice(0, 5);
              if (!prospect.name.trim() || topics.length === 0) {
                setError("A name and at least one topic are required.");
                return;
              }
              generate.mutate({
                subjectName: prospect.name.trim(),
                aliases,
                topics,
              });
            }}
          >
            <p className="text-sm text-[#8a6a5a]">
              Recruiting tool: generate a report for an expert who does not have
              an account yet. Kept inside the portal.
            </p>
            <input
              className="w-full rounded-lg border border-[#E8DDD0] px-3 py-2 text-sm"
              placeholder="Full name, e.g. Jane Smith"
              value={prospect.name}
              onChange={(e) =>
                setProspect({ ...prospect, name: e.target.value })
              }
              data-testid="input-aivis-prospect-name"
            />
            <input
              className="w-full rounded-lg border border-[#E8DDD0] px-3 py-2 text-sm"
              placeholder="Aliases, comma-separated (optional)"
              value={prospect.aliases}
              onChange={(e) =>
                setProspect({ ...prospect, aliases: e.target.value })
              }
              data-testid="input-aivis-prospect-aliases"
            />
            <textarea
              className="w-full rounded-lg border border-[#E8DDD0] px-3 py-2 text-sm"
              rows={2}
              placeholder="Topics, comma-separated, e.g. healthy aging, loneliness after retirement"
              value={prospect.topics}
              onChange={(e) =>
                setProspect({ ...prospect, topics: e.target.value })
              }
              data-testid="input-aivis-prospect-topics"
            />
            <button
              type="submit"
              disabled={generate.isPending}
              className="rounded-full bg-[#8C1515] hover:bg-[#a01a1a] text-white text-sm font-semibold px-5 py-2 transition disabled:opacity-50"
              data-testid="button-aivis-prospect-generate"
            >
              Generate prospect report
            </button>
          </form>
        )}

        {reports.length > 1 && (
          <div className="mt-6 flex flex-wrap gap-2">
            {reports.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                className={`text-xs rounded-full px-3 py-1.5 border transition ${
                  activeId === r.id
                    ? "bg-[#572020] text-white border-[#572020]"
                    : "bg-white text-[#572020] border-[#E8DDD0] hover:bg-[#F9F5EE]"
                }`}
                data-testid={`button-aivis-report-${r.id}`}
              >
                {r.subjectName}
                {r.isProspect ? " (prospect)" : ""} ·{" "}
                {new Date(r.createdAt).toLocaleDateString()}
                {r.status === "running"
                  ? " · running…"
                  : r.status === "failed"
                    ? " · failed"
                    : ""}
              </button>
            ))}
          </div>
        )}

        {activeId != null ? (
          <AiVisReportView id={activeId} />
        ) : listQuery.isLoading ? (
          <p className="mt-8 text-sm text-[#8a6a5a]">Loading…</p>
        ) : (
          <div className="mt-8 rounded-xl border border-[#E8DDD0] bg-white p-6 max-w-2xl">
            <p className="text-sm text-[#572020]">
              No report yet.{" "}
              {isSteward || isAdmin
                ? "Generate your first one — it takes about a minute and shows exactly what AI assistants tell people about your field today."
                : "Reports are available to pillar stewards. If you steward a pillar, your report will appear here."}
            </p>
          </div>
        )}
      </div>
    </PortalShell>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey!}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      localization={clerkLocalization}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <ViewAsBanner />
        <Switch>
          <Route path="/" component={HomeRedirect} />
          <Route path="/stewardship" component={StewardshipProspectus} />
          <Route path="/sign-in/*?" component={SignInPage} />
          <Route path="/sign-up/*?" component={SignUpPage} />
          <Route path="/invite/:token" component={AcceptInvite} />
          <Route path="/dashboard">
            <Protected>
              <Dashboard />
            </Protected>
          </Route>
          <Route path="/answer">
            <Protected>
              <AslmGuard>
                <QuickAnswerPage />
              </AslmGuard>
            </Protected>
          </Route>
          <Route path="/gaps">
            <Protected>
              <AslmGuard>
                <GapsPage />
              </AslmGuard>
            </Protected>
          </Route>
          <Route path="/aslm-usage">
            <Protected>
              <AslmUsagePage />
            </Protected>
          </Route>
          <Route path="/admin">
            <Protected>
              <AdminMembers />
            </Protected>
          </Route>
          <Route path="/admin/admissions">
            <Protected>
              <AdminAdmissions />
            </Protected>
          </Route>
          <Route path="/admin/data">
            <Protected>
              <AdminPillarData />
            </Protected>
          </Route>
          <Route path="/decisions/:id">
            <Protected>
              <AslmGuard>
                <DecisionMemoPage />
              </AslmGuard>
            </Protected>
          </Route>
          <Route path="/decisions">
            <Protected>
              <AslmGuard>
                <DecisionLibraryPage />
              </AslmGuard>
            </Protected>
          </Route>
          <Route path="/awaiting-invite">
            <Protected>
              <AwaitingInvite />
            </Protected>
          </Route>
          <Route path="/pillars/:slug/library">
            <Protected>
              <PillarLibrary />
            </Protected>
          </Route>
          <Route path="/pillars/:slug/knowledge">
            <Protected>
              <KnowledgeWorkspace fetchJson={fetchJson} Shell={PortalShell} />
            </Protected>
          </Route>
          <Route path="/pillars/:slug/inbox">
            <Protected>
              <StewardInbox />
            </Protected>
          </Route>
          <Route path="/pillars/:slug/sources/:id">
            <Protected>
              <SourceDetailPage />
            </Protected>
          </Route>
          <Route path="/pillars/:slug/analytics">
            <Protected>
              <PillarAnalytics />
            </Protected>
          </Route>
          <Route path="/pillars/:slug/coach-videos">
            <Protected>
              <CoachVideoManager fetchJson={fetchJson} />
            </Protected>
          </Route>
          <Route path="/pillars/:slug">
            <Protected>
              <PillarDetail />
            </Protected>
          </Route>
          <Route path="/evals/:id">
            <Protected>
              <AslmGuard>
                <EvalRunPage />
              </AslmGuard>
            </Protected>
          </Route>
          <Route path="/evals">
            <Protected>
              <AslmGuard>
                <EvalIndexPage />
              </AslmGuard>
            </Protected>
          </Route>
          <Route path="/newsletter">
            <Protected>
              <AslmGuard>
                <FacultyNewsletter />
              </AslmGuard>
            </Protected>
          </Route>
          <Route path="/my-newsletter">
            <Protected>
              <AslmGuard>
                <MyNewsletter />
              </AslmGuard>
            </Protected>
          </Route>
          <Route path="/voice">
            <Protected>
              <VoiceProfilePage />
            </Protected>
          </Route>
          <Route path="/visibility">
            <Protected>
              <AslmGuard>
                <AiVisibilityPage />
              </AslmGuard>
            </Protected>
          </Route>
          <Route path="/frameworks">
            <Protected>
              <FrameworksPage />
            </Protected>
          </Route>
          <Route path="/settings">
            <Protected>
              <SettingsPage />
            </Protected>
          </Route>
          <Route path="/explore/interpretations/:id">
            <Protected>
              <AslmGuard>
                <CrossPillarInterpretationPage />
              </AslmGuard>
            </Protected>
          </Route>
          <Route path="/explore">
            <Protected>
              <AslmGuard>
                <CrossPillarBrowser />
              </AslmGuard>
            </Protected>
          </Route>
          <Route path="/requests">
            <Protected>
              <AslmGuard>
                <MergeRequestsPage />
              </AslmGuard>
            </Protected>
          </Route>
          <Route path="/welcome">
            <Protected>
              <Welcome />
            </Protected>
          </Route>
          <Route>
            <Redirect to="/" />
          </Route>
        </Switch>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

export default function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}
