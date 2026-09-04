import { useEffect, useState } from "react";
import { ClerkProvider, SignIn, Show, useClerk, useUser } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import {
  Layers,
  TrendingUp,
  MapPin,
  Flame,
  UserPlus,
  Mail,
  DollarSign,
  Briefcase,
  LogOut,
} from "lucide-react";

// ── Clerk wiring (scoped to this page only; the rest of palonur is Clerk-free) ──
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const CREAM = "#f8f4f4";
const CARDINAL = "#8B1A1A";
const INK = "#2a1a1a";
const MUTED = "#8a7a7a";
const BORDER = "#e8e0e0";

const clerkAppearance = {
  variables: {
    colorPrimary: CARDINAL,
    colorBackground: "#FBF7F0",
    colorForeground: "#572020",
    colorMutedForeground: MUTED,
    colorInput: "#FFFFFF",
    colorInputForeground: "#572020",
    colorNeutral: BORDER,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    borderRadius: "8px",
  },
} as const;

const BASE = import.meta.env.BASE_URL; // trailing slash; "/" for palonur

interface MeUser {
  id: number;
  email: string;
  fullName: string | null;
  isPlatformAdmin: boolean;
}
interface Me {
  user: MeUser;
}

type Card = {
  icon: React.ReactNode;
  title: string;
  desc: string;
  href: string;
};

const SECTIONS: Array<{ label: string; cards: Card[] }> = [
  {
    label: "Pillars",
    cards: [
      {
        icon: <Layers size={22} />,
        title: "Pillar workspaces",
        desc: "Every Stanford pillar — sources, interpretations, stewards.",
        href: "/faculty/dashboard",
      },
    ],
  },
  {
    label: "User Data",
    cards: [
      {
        icon: <TrendingUp size={22} />,
        title: "Retention",
        desc: "Sessions, returning users and sleep-log activity.",
        href: `${BASE}admin?tab=users`,
      },
      {
        icon: <MapPin size={22} />,
        title: "Location distribution",
        desc: "Where readers are asking from.",
        href: `${BASE}admin?tab=traffic`,
      },
      {
        icon: <Flame size={22} />,
        title: "Hot topics",
        desc: "What people are asking the sleep agent.",
        href: `${BASE}admin?tab=traffic`,
      },
      {
        icon: <UserPlus size={22} />,
        title: "Current onboardings",
        desc: "New users and the waitlist.",
        href: `${BASE}admin?tab=waitlist`,
      },
      {
        icon: <Mail size={22} />,
        title: "Subscribers",
        desc: "Newsletter list, issues and sends.",
        href: `${BASE}newsletter-admin`,
      },
      {
        icon: <DollarSign size={22} />,
        title: "Revenue",
        desc: "The SLM business plan and projections.",
        href: `${BASE}business-plan-slm.html`,
      },
    ],
  },
  {
    label: "Investor Relations",
    cards: [
      {
        icon: <Briefcase size={22} />,
        title: "Investor relations",
        desc: "Investor list, outreach and updates.",
        href: `${BASE}admin?tab=investors`,
      },
    ],
  },
];

function CardLink({ card }: { card: Card }) {
  const [hover, setHover] = useState(false);
  return (
    <a
      href={card.href}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      data-testid={`card-${card.title.toLowerCase().replace(/\s+/g, "-")}`}
      style={{
        display: "block",
        background: "#fff",
        border: `1px solid ${hover ? CARDINAL : BORDER}`,
        borderRadius: 16,
        padding: "22px 22px 20px",
        textDecoration: "none",
        color: INK,
        transition: "border-color .15s ease, transform .15s ease, box-shadow .15s ease",
        transform: hover ? "translateY(-2px)" : "none",
        boxShadow: hover
          ? "0 10px 28px -12px rgba(139,26,26,.28)"
          : "0 1px 2px rgba(0,0,0,.03)",
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#faf2f2",
          color: CARDINAL,
          marginBottom: 14,
        }}
      >
        {card.icon}
      </div>
      <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>
        {card.title}
      </div>
      <div style={{ fontSize: 13.5, lineHeight: 1.5, color: MUTED }}>
        {card.desc}
      </div>
    </a>
  );
}

function Hub() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [state, setState] = useState<"checking" | "ok" | "denied" | "error">(
    "checking",
  );
  const [name, setName] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/faculty/me", { credentials: "include" });
        if (!res.ok) throw new Error(String(res.status));
        const me = (await res.json()) as Me;
        if (cancelled) return;
        if (!me.user?.isPlatformAdmin) {
          setState("denied");
          return;
        }
        setName(me.user.fullName?.trim().split(/\s+/)[0] || "");
        // Bridge the Clerk session into the password-gated admin pages so the
        // cards open without a second password prompt.
        await fetch("/api/faculty/admin/command-center-session", {
          method: "POST",
          credentials: "include",
        }).catch(() => {});
        if (!cancelled) setState("ok");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "checking") {
    return (
      <Centered>
        <p style={{ color: MUTED }}>Loading your command center…</p>
      </Centered>
    );
  }

  if (state === "denied") {
    return (
      <Centered>
        <div style={{ textAlign: "center", maxWidth: 420 }}>
          <h1 style={{ fontFamily: "Georgia, serif", fontSize: 28, color: INK, marginBottom: 12 }}>
            Not your stop
          </h1>
          <p style={{ color: MUTED, marginBottom: 24, lineHeight: 1.6 }}>
            This command center is for platform admins only. You're signed in as{" "}
            {user?.primaryEmailAddress?.emailAddress ?? "an unrecognized account"}.
          </p>
          <button
            onClick={() => signOut()}
            style={{
              background: CARDINAL,
              color: "#fff",
              border: "none",
              borderRadius: 10,
              padding: "10px 18px",
              fontSize: 14,
              cursor: "pointer",
            }}
            data-testid="button-signout-denied"
          >
            Sign out
          </button>
        </div>
      </Centered>
    );
  }

  if (state === "error") {
    return (
      <Centered>
        <p style={{ color: MUTED }}>
          Something went wrong reaching the server. Try refreshing.
        </p>
      </Centered>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: CREAM }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "20px 28px",
          borderBottom: `1px solid ${BORDER}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "Georgia, serif", fontSize: 22, color: INK }}>
            palonur
          </span>
          <span style={{ fontSize: 10, letterSpacing: "0.25em", color: CARDINAL }}>
            COMMAND CENTER
          </span>
        </div>
        <button
          onClick={() => signOut()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            background: "transparent",
            color: MUTED,
            border: `1px solid ${BORDER}`,
            borderRadius: 10,
            padding: "8px 14px",
            fontSize: 13,
            cursor: "pointer",
          }}
          data-testid="button-signout"
        >
          <LogOut size={15} /> Sign out
        </button>
      </header>

      <main style={{ maxWidth: 1080, margin: "0 auto", padding: "40px 28px 80px" }}>
        <h1
          style={{
            fontFamily: "Georgia, serif",
            fontSize: 34,
            color: INK,
            marginBottom: 6,
          }}
        >
          {name ? `Welcome, ${name}.` : "Welcome."}
        </h1>
        <p style={{ color: MUTED, fontSize: 15, marginBottom: 40 }}>
          Everything in one place. Pick where you want to go.
        </p>

        {SECTIONS.map((section) => (
          <section key={section.label} style={{ marginBottom: 44 }}>
            <div
              style={{
                fontSize: 11,
                letterSpacing: "0.22em",
                textTransform: "uppercase",
                color: CARDINAL,
                marginBottom: 16,
                fontWeight: 600,
              }}
            >
              {section.label}
            </div>
            <div
              style={{
                display: "grid",
                gap: 18,
                gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              }}
            >
              {section.cards.map((c) => (
                <CardLink key={c.title} card={c} />
              ))}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: CREAM,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      {children}
    </div>
  );
}

export default function CommandCenter() {
  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = CREAM;
    document.title = "Command Center · Palonur";
    return () => {
      document.body.style.background = prev;
    };
  }, []);

  if (!clerkPubKey) {
    return (
      <Centered>
        <p style={{ color: MUTED }}>Sign-in is not configured.</p>
      </Centered>
    );
  }

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
    >
      <Show when="signed-in">
        <Hub />
      </Show>
      <Show when="signed-out">
        <Centered>
          <SignIn routing="hash" appearance={clerkAppearance} />
        </Centered>
      </Show>
    </ClerkProvider>
  );
}
