import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SLMBrand } from "../components/SLMBrand";
import { ConsentLine } from "../components/consent-line";
import {
  readPendingQuestion,
  destinationWithPendingQuestion,
} from "../lib/pending-question";
import { getSleepTestimonials } from "../lib/testimonials";
import { SCIENCE_SIGNED } from "../lib/science-signed";

const API_BASE = "/api";
const RED = "#8B1A1A";

interface Plan {
  productId: string;
  priceId: string;
  name: string | null;
  description: string | null;
  planKey: string | null;
  unitAmount: number | null;
  currency: string | null;
  interval: string | null;
  plan: "monthly" | "annual" | null;
}

interface Subscription {
  active: boolean;
  status: string | null;
  plan: "monthly" | "annual" | null;
  interval: string | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}

interface Me {
  authenticated: boolean;
  email?: string;
  subscription?: Subscription;
}

// Display metadata per tier — only order/featured; UI strings come from locale.
interface TierMeta {
  order: number;
  featured?: boolean;
  includesKey?: string;
}
const TIER_META_FLAGS: Record<string, TierMeta> = {
  premium: { order: 1 },
  nightly: { order: 1 },
  newsletter: { order: 4 },
  all_access: { order: 1, featured: true },
};

// EN fallback titles (only used in the post-checkout welcome headline).
const TIER_EN_TITLE: Record<string, string> = {
  premium: "Pal",
  nightly: "Pal",
  newsletter: "Newsletter Premium",
  all_access: "Palonur All-Access",
};

// Nightly includes keys (referenced in TIER_META via locale).
const NIGHTLY_LOCALE_KEY = "tiers.nightly.includes";
const ALL_ACCESS_LOCALE_KEY = "tiers.all_access";

// Storefront: All-Access is the one visible offer.
const TOOL_KEYS = new Set(["all_access"]);
const BUNDLE_KEY = "all_access";
const SHOW_BUNDLE = false;

interface Tier {
  key: string;
  order: number;
  featured?: boolean;
  name: string | null;
  monthly?: Plan;
  annual?: Plan;
}

// Pillar grid: icons are stable, names come from locale.
const PILLARS_ICONS: { icon: string; soon?: boolean }[] = [
  { icon: "🌙" },
  { icon: "🥦" },
  { icon: "🏃" },
  { icon: "🧘" },
  { icon: "🧠" },
  { icon: "✨" },
  { icon: "✨" },
  { icon: "💛" },
  { icon: "🔬", soon: true },
];

function SectionLabel({
  children,
  align = "center",
}: {
  children: React.ReactNode;
  align?: "center" | "left";
}) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: ".14em",
        textTransform: "uppercase",
        color: "#b08a8a",
        textAlign: align,
        marginBottom: 16,
      }}
    >
      {children}
    </div>
  );
}

function MoonMark() {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 26 26"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path
        d="M22 15.6A9.2 9.2 0 1 1 10.4 4a7.4 7.4 0 0 0 11.6 11.6Z"
        fill={RED}
      />
      <circle cx="20.5" cy="6.2" r="1.15" fill="#d8a93b" />
      <circle cx="16.4" cy="3.4" r="0.8" fill="#d8a93b" />
    </svg>
  );
}

function formatPrice(amount: number | null, currency: string | null): string {
  if (amount == null) return "—";
  const value = amount / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency ?? "usd").toUpperCase(),
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
  }).format(value);
}

function perMonthEquivalent(
  annualAmount: number | null,
  currency: string | null,
): string {
  if (annualAmount == null) return "—";
  return formatPrice(Math.round(annualAmount / 12), currency);
}

export default function Subscribe() {
  const { t, i18n } = useTranslation("subscribe");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [billing, setBilling] = useState<"monthly" | "annual">("monthly");
  const [selectedPriceId, setSelectedPriceId] = useState<string>("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [me, setMe] = useState<Me | null>(null);
  const [notice, setNotice] = useState("");
  // Referral banner: shown when ?ref=CODE present in URL
  const [refBanner, setRefBanner] = useState<{
    code: string;
    name: string | null;
  } | null>(null);
  // Set after a successful checkout return for a NEW buyer (not yet signed in):
  // drives a focused post-purchase confirmation view instead of re-rendering the
  // Nightly storefront under them.
  const [checkoutDone, setCheckoutDone] = useState<{
    email?: string;
    product?: string | null;
    destination?: string;
    heldQuestion?: string;
  } | null>(null);

  const [showSignIn, setShowSignIn] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInSent, setSignInSent] = useState(false);

  const [freeMode, setFreeMode] = useState(false);
  const [freeEmail, setFreeEmail] = useState("");
  const [freeSent, setFreeSent] = useState(false);
  const [freeLoading, setFreeLoading] = useState(false);
  const [freeError, setFreeError] = useState("");

  // ── Referral code detection ──────────────────────────────────────────────
  // Two paths: (a) ?ref=CODE in URL (fresh click), (b) ref_code persisted
  // cookie from a prior click on /sleep?ref=CODE (returned visitor).
  useEffect(() => {
    const refCode = new URLSearchParams(window.location.search).get("ref");
    if (refCode) {
      // Fresh click — track it (sets ref_code cookie server-side) then banner.
      fetch(`${API_BASE}/referral/track`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ code: refCode }),
      }).catch(() => {});
      fetch(`${API_BASE}/referral/owner?code=${encodeURIComponent(refCode)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { firstName: string | null } | null) => {
          setRefBanner({ code: refCode, name: d?.firstName ?? null });
        })
        .catch(() => setRefBanner({ code: refCode, name: null }));
    } else {
      // No query param — check whether a ref_code cookie was set by a prior
      // click on /sleep?ref=CODE. /api/referral/ref reads the httpOnly cookie
      // server-side and returns the code + owner name.
      fetch(`${API_BASE}/referral/ref`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { code: string; firstName: string | null } | null) => {
          if (d?.code)
            setRefBanner({ code: d.code, name: d.firstName ?? null });
        })
        .catch(() => {});
    }
  }, []);

  // ── Bootstrap: handle checkout return, magic-link, and current state ──────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get("checkout");
    const sessionId = params.get("session_id");
    const loginToken = params.get("login");
    if (params.get("plan") === "free") setFreeMode(true);

    function clearQuery() {
      window.history.replaceState({}, "", window.location.pathname);
    }

    async function refreshMe() {
      try {
        const res = await fetch(`${API_BASE}/consumer/me`, {
          credentials: "include",
        });
        if (res.ok) setMe(await res.json());
      } catch {
        /* ignore */
      }
    }

    async function run() {
      if (checkout === "success" && sessionId) {
        try {
          const res = await fetch(`${API_BASE}/billing/confirm`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ sessionId }),
          });
          if (res.ok) {
            const data = (await res.json()) as Me & {
              emailVerificationSent?: boolean;
              email?: string;
              product?: string | null;
              destination?: string;
            };
            if (data.emailVerificationSent) {
              const pending = readPendingQuestion();
              setCheckoutDone({
                email: data.email,
                product: data.product,
                destination: data.destination,
                heldQuestion:
                  pending && pending.path === data.destination
                    ? pending.q
                    : undefined,
              });
              clearQuery();
              return;
            } else {
              setMe({ ...data, authenticated: true });
              setNotice(t("notice.takingYouIn"));
              clearQuery();
              try {
                sessionStorage.setItem("palonur_demo_authed", "1");
              } catch {
                /* ignore */
              }
              window.location.href = destinationWithPendingQuestion(
                data.destination ?? "/account",
              );
              return;
            }
          }
        } catch {
          /* fall through to refreshMe */
        }
        clearQuery();
        await refreshMe();
        return;
      }
      if (checkout === "cancelled") {
        setNotice(t("notice.cancelled"));
        clearQuery();
      }
      if (loginToken) {
        try {
          const res = await fetch(
            `${API_BASE}/consumer/auth/consume?token=${encodeURIComponent(loginToken)}`,
            { credentials: "include" },
          );
          if (res.ok) {
            clearQuery();
            window.location.href = "/account";
            return;
          }
          setError("That sign-in link has expired. Request a new one.");
        } catch {
          setError("Could not sign in. Request a new link.");
        }
        clearQuery();
      }
      await refreshMe();
    }
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load plans ────────────────────────────────────────────────────────────
  useEffect(() => {
    async function loadPlans() {
      try {
        const res = await fetch(`${API_BASE}/billing/plans`);
        if (res.ok) {
          const data = (await res.json()) as { plans: Plan[] };
          setPlans(data.plans ?? []);
        }
      } catch {
        /* leave plans empty */
      } finally {
        setPlansLoading(false);
      }
    }
    void loadPlans();
  }, []);

  const isSubscribed = Boolean(me?.authenticated && me?.subscription?.active);
  const doneTitle =
    checkoutDone?.product != null
      ? (TIER_EN_TITLE[checkoutDone.product] ?? null)
      : null;

  // Group prices into tiers.
  const tiers = useMemo<Tier[]>(() => {
    const map = new Map<string, Tier>();
    for (const p of plans) {
      const key = p.planKey ?? p.productId;
      let tier = map.get(key);
      if (!tier) {
        const flags = TIER_META_FLAGS[key] ?? { order: 50 };
        tier = {
          key,
          order: flags.order,
          featured: flags.featured,
          name: p.name,
        };
        map.set(key, tier);
      }
      if (p.plan === "annual") tier.annual = p;
      else if (p.plan === "monthly") tier.monthly = p;
    }
    const priceOf = (t: Tier) =>
      t.monthly?.unitAmount ?? t.annual?.unitAmount ?? 0;
    return Array.from(map.values()).sort(
      (a, b) => priceOf(b) - priceOf(a) || a.order - b.order,
    );
  }, [plans]);

  const toolTiers = useMemo(
    () => tiers.filter((tier) => TOOL_KEYS.has(tier.key)),
    [tiers],
  );
  const bundleTier = useMemo(
    () => tiers.find((tier) => tier.key === BUNDLE_KEY),
    [tiers],
  );
  const hasAnnual = useMemo(
    () =>
      toolTiers.some((tier) => tier.annual) ||
      (SHOW_BUNDLE && Boolean(bundleTier?.annual)),
    [toolTiers, bundleTier],
  );

  function priceForTier(tier: Tier): Plan | undefined {
    return (
      (billing === "annual" ? tier.annual : tier.monthly) ??
      tier.monthly ??
      tier.annual
    );
  }

  const leadTier = toolTiers[0];
  const leadPrice = leadTier ? priceForTier(leadTier) : undefined;

  useEffect(() => {
    if (selectedPriceId) return;
    const lead = toolTiers[0];
    if (!lead) return;
    const price =
      (billing === "annual" ? lead.annual : lead.monthly) ??
      lead.monthly ??
      lead.annual;
    if (price) setSelectedPriceId(price.priceId);
  }, [toolTiers, billing, selectedPriceId]);

  async function handleCheckout(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !selectedPriceId) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/billing/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: email.trim(), priceId: selectedPriceId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "error");
      }
      const data = (await res.json()) as { url: string };
      window.location.href = data.url;
    } catch (err) {
      setError(
        err instanceof Error && err.message !== "error"
          ? err.message
          : "Something went wrong — please try again.",
      );
      setLoading(false);
    }
  }

  async function handlePortal() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/billing/portal`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("error");
      const data = (await res.json()) as { url: string };
      window.location.href = data.url;
    } catch {
      setError("Could not open the billing portal.");
      setLoading(false);
    }
  }

  async function handleSignInRequest(e: React.FormEvent) {
    e.preventDefault();
    if (!signInEmail.trim()) return;
    setLoading(true);
    setError("");
    try {
      await fetch(`${API_BASE}/consumer/auth/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: signInEmail.trim() }),
      });
      setSignInSent(true);
    } catch {
      setError("Could not send the sign-in link.");
    } finally {
      setLoading(false);
    }
  }

  async function handleFreeSignup(e: React.FormEvent) {
    e.preventDefault();
    if (!freeEmail.trim()) return;
    setFreeLoading(true);
    setFreeError("");
    try {
      const res = await fetch(`${API_BASE}/consumer/auth/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: freeEmail.trim() }),
      });
      if (!res.ok) throw new Error("request failed");
      setFreeSent(true);
    } catch {
      setFreeError("Could not send your sign-up link. Please try again.");
    } finally {
      setFreeLoading(false);
    }
  }

  async function handleLogout() {
    await fetch(`${API_BASE}/consumer/auth/logout`, {
      method: "POST",
      credentials: "include",
    }).catch(() => {});
    setMe({ authenticated: false });
    setNotice("");
  }

  const valueItems = t("valuePoints.items", { returnObjects: true }) as Array<{
    h: string;
    p: string;
  }>;
  const freeBullets = t("free.bullets", { returnObjects: true }) as string[];
  const pillarsItems = t("pillarsGrid.items", {
    returnObjects: true,
  }) as string[];
  const nightlyIncludes = t(NIGHTLY_LOCALE_KEY, {
    returnObjects: true,
  }) as string[];
  const allAccessIncludes = t(`${ALL_ACCESS_LOCALE_KEY}.includes`, {
    returnObjects: true,
  }) as string[];

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "#fafaf7",
        fontFamily: "'Inter', -apple-system, system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <style>{`
        @keyframes fadeUp { from { opacity:0; transform:translateY(16px);} to { opacity:1; transform:translateY(0);} }
        .sub-input:focus { border-color: rgba(139,26,26,.5) !important; outline: none; }
        .sub-btn:hover:not(:disabled) { opacity: 0.88; }
        .sub-grid { display:grid; grid-template-columns: 1.04fr 0.96fr; gap: 44px; align-items:start; }
        .sub-pricecard { position: sticky; top: 24px; }
        @media (max-width: 820px) {
          .sub-grid { grid-template-columns: 1fr; gap: 32px; }
          .sub-pricecard { position: static; }
        }
      `}</style>

      {/* Header */}
      <header
        style={{
          padding: "20px 32px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid rgba(139,26,26,.07)",
        }}
      >
        <a href={import.meta.env.BASE_URL} style={{ textDecoration: "none" }}>
          <SLMBrand size="sm" />
        </a>
        <a
          href={`${import.meta.env.BASE_URL}account`}
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: RED,
            textDecoration: "none",
            letterSpacing: ".01em",
          }}
        >
          {t("header.yourAccount")}
        </a>
      </header>

      {/* Main */}
      <main
        style={{
          flex: 1,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          padding: "48px 24px 72px",
        }}
      >
        <div
          style={{
            maxWidth: isSubscribed || checkoutDone ? 540 : 1000,
            width: "100%",
            animation: "fadeUp .5s ease both",
          }}
        >
          {refBanner && (
            <div
              style={{
                background: "linear-gradient(135deg, #fff8f0, #fff3e8)",
                border: "1px solid rgba(139,26,26,.18)",
                borderRadius: 12,
                padding: "14px 18px",
                fontSize: 14,
                marginBottom: 24,
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <span style={{ fontSize: 20 }}>🎁</span>
              <div style={{ flex: 1 }}>
                <span style={{ fontWeight: 700, color: "#1a0505" }}>
                  {refBanner.name
                    ? `${refBanner.name} gave you 5 bonus free questions.`
                    : "You have 5 bonus free questions waiting."}
                </span>
                <span style={{ color: "#8a6a5a", marginLeft: 8 }}>
                  Sign up free to claim them.
                </span>
              </div>
              <button
                onClick={() => setRefBanner(null)}
                aria-label="Dismiss"
                style={{
                  flexShrink: 0,
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "#8a6a5a",
                  fontSize: 18,
                  lineHeight: 1,
                  padding: "0 2px",
                  opacity: 0.7,
                }}
              >
                &times;
              </button>
            </div>
          )}
          {notice && (
            <div
              style={{
                background: "#f0f6ef",
                color: "#2c5e2c",
                border: "1px solid #cfe3cd",
                borderRadius: 10,
                padding: "12px 16px",
                fontSize: 14,
                marginBottom: 24,
              }}
            >
              {notice}
            </div>
          )}

          {checkoutDone ? (
            /* ── Post-checkout confirmation (new buyer) ─────────────── */
            <div
              style={{
                animation: "fadeUp .4s ease both",
                textAlign: "center",
                padding: "8px 0",
              }}
            >
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: "50%",
                  background: "#f0f6ef",
                  border: "1px solid #cfe3cd",
                  color: "#2c5e2c",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 28,
                  margin: "0 auto 20px",
                }}
              >
                ✓
              </div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: ".14em",
                  textTransform: "uppercase",
                  color: RED,
                  marginBottom: 12,
                }}
              >
                {t("checkout.badge")}
              </div>
              <h1
                style={{
                  fontSize: 26,
                  fontWeight: 700,
                  color: "#241a17",
                  margin: "0 0 14px",
                  lineHeight: 1.25,
                }}
              >
                {doneTitle
                  ? t("checkout.welcomeTo", { title: doneTitle })
                  : t("checkout.youreSubscribed")}
              </h1>
              {checkoutDone.heldQuestion ? (
                <>
                  <div
                    style={{
                      fontSize: 15.5,
                      color: "#241a17",
                      fontFamily: "'Georgia', serif",
                      fontStyle: "italic",
                      lineHeight: 1.55,
                      margin: "0 auto 16px",
                      maxWidth: 430,
                      padding: "12px 16px",
                      background: "rgba(139,26,26,0.05)",
                      borderLeft: `3px solid ${RED}`,
                      borderRadius: "0 8px 8px 0",
                      textAlign: "left",
                    }}
                  >
                    "{checkoutDone.heldQuestion}"
                  </div>
                  <p
                    style={{
                      fontSize: 15,
                      lineHeight: 1.65,
                      color: "#5b514c",
                      margin: "0 auto 26px",
                      maxWidth: 430,
                    }}
                  >
                    {t("checkout.heldBody", {
                      email: checkoutDone.email ?? "your inbox",
                    })}
                  </p>
                </>
              ) : (
                <>
                  <p
                    style={{
                      fontSize: 15,
                      lineHeight: 1.65,
                      color: "#5b514c",
                      margin: "0 auto 26px",
                      maxWidth: 430,
                    }}
                  >
                    {t("checkout.body", {
                      email: checkoutDone.email ?? "your inbox",
                      destination: doneTitle ?? t("checkout.yourMemberArea"),
                    })}
                  </p>
                </>
              )}
              <a
                href={`${import.meta.env.BASE_URL}account`}
                style={{
                  display: "inline-block",
                  background: RED,
                  color: "#fff",
                  fontSize: 14,
                  fontWeight: 600,
                  textDecoration: "none",
                  padding: "12px 22px",
                  borderRadius: 10,
                }}
              >
                {t("checkout.goAccount")}
              </a>
              <p
                style={{
                  fontSize: 13,
                  color: "#9a8f88",
                  marginTop: 18,
                  marginBottom: 0,
                }}
              >
                {t("checkout.noEmail")}
              </p>
            </div>
          ) : isSubscribed ? (
            /* ── Subscribed state ──────────────────────────────────── */
            <div style={{ animation: "fadeUp .4s ease both" }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: ".14em",
                  textTransform: "uppercase",
                  color: RED,
                  marginBottom: 16,
                }}
              >
                {t("subscribed.badge")}
              </div>
              <h1
                style={{
                  fontSize: "clamp(26px, 5vw, 38px)",
                  fontWeight: 700,
                  color: "#1a0505",
                  lineHeight: 1.18,
                  letterSpacing: "-0.02em",
                  marginBottom: 16,
                  fontFamily: "'Georgia', 'Times New Roman', serif",
                }}
              >
                {t("subscribed.allSet")}
              </h1>
              <p
                style={{
                  fontSize: 15,
                  color: "#666",
                  lineHeight: 1.65,
                  marginBottom: 8,
                }}
              >
                {t("subscribed.signedInAs")} <strong>{me?.email}</strong>.{" "}
                {me?.subscription?.plan
                  ? `${t(`subscribed.plan.${me.subscription.plan}`)} `
                  : ""}
                {me?.subscription?.cancelAtPeriodEnd
                  ? t("subscribed.planCancels")
                  : t("subscribed.planActive")}
              </p>
              {me?.subscription?.currentPeriodEnd && (
                <p style={{ fontSize: 13, color: "#999", marginBottom: 28 }}>
                  {me.subscription.cancelAtPeriodEnd
                    ? t("subscribed.accessUntil")
                    : t("subscribed.renews")}{" "}
                  {new Date(
                    me.subscription.currentPeriodEnd * 1000,
                  ).toLocaleDateString()}
                  .
                </p>
              )}
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <a
                  href={`${import.meta.env.BASE_URL}account`}
                  style={{
                    display: "inline-block",
                    background: RED,
                    color: "#fff",
                    textDecoration: "none",
                    borderRadius: 12,
                    padding: "13px 26px",
                    fontSize: 14,
                    fontWeight: 700,
                  }}
                >
                  {t("subscribed.manageAccount")}
                </a>
                <button
                  onClick={handlePortal}
                  disabled={loading}
                  className="sub-btn"
                  style={{
                    background: "#fff",
                    color: RED,
                    border: "1.5px solid #e2d8d8",
                    borderRadius: 12,
                    padding: "13px 26px",
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: loading ? "wait" : "pointer",
                  }}
                >
                  {t("subscribed.manageBilling")}
                </button>
              </div>
              {error && (
                <p
                  style={{
                    marginTop: 14,
                    marginBottom: 0,
                    fontSize: 13.5,
                    color: "#b3261e",
                  }}
                >
                  {error}
                </p>
              )}
              <button
                onClick={handleLogout}
                style={{
                  marginTop: 24,
                  background: "none",
                  border: "none",
                  color: "#999",
                  fontSize: 13,
                  cursor: "pointer",
                  textDecoration: "underline",
                }}
              >
                {t("subscribed.signOut")}
              </button>
            </div>
          ) : (
            /* ── Plan selection / checkout ─────────────────────────── */
            <>
              {freeMode && (
                <div
                  style={{
                    maxWidth: 480,
                    margin: "0 auto 44px",
                    background: "#fff",
                    border: "1.5px solid #e2d8d8",
                    borderRadius: 18,
                    padding: "30px 28px",
                    boxShadow: "0 8px 24px rgba(139,26,26,0.05)",
                    textAlign: "center",
                  }}
                >
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: ".14em",
                      textTransform: "uppercase",
                      color: RED,
                      marginBottom: 12,
                    }}
                  >
                    {t("free.badge")}
                  </div>
                  <h2
                    style={{
                      fontSize: "clamp(24px, 4vw, 32px)",
                      fontWeight: 700,
                      color: "#1a0505",
                      lineHeight: 1.15,
                      letterSpacing: "-0.02em",
                      margin: "0 0 18px",
                      fontFamily: "'Georgia', 'Times New Roman', serif",
                    }}
                  >
                    {t("free.headline")}
                  </h2>
                  <ul
                    style={{
                      listStyle: "none",
                      padding: 0,
                      margin: "0 0 22px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                      textAlign: "left",
                    }}
                  >
                    {Array.isArray(freeBullets) &&
                      freeBullets.map((b) => (
                        <li
                          key={b}
                          style={{
                            position: "relative",
                            paddingLeft: 22,
                            fontSize: 14,
                            color: "#4a3535",
                            lineHeight: 1.5,
                          }}
                        >
                          <span
                            style={{
                              position: "absolute",
                              left: 0,
                              top: 7,
                              width: 7,
                              height: 7,
                              borderRadius: "50%",
                              background: RED,
                            }}
                          />
                          {b}
                        </li>
                      ))}
                  </ul>
                  {freeSent ? (
                    <div
                      style={{
                        fontSize: 14,
                        color: "#2c5e2c",
                        background: "#f0f6ef",
                        border: "1px solid #cfe3cd",
                        borderRadius: 10,
                        padding: "12px 16px",
                      }}
                    >
                      {t("free.checkInbox")}
                    </div>
                  ) : (
                    <form
                      onSubmit={handleFreeSignup}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                      }}
                    >
                      <input
                        className="sub-input"
                        type="email"
                        value={freeEmail}
                        onChange={(e) => setFreeEmail(e.target.value)}
                        placeholder={t("free.emailPlaceholder")}
                        required
                        style={{
                          border: "1.5px solid #e2d8d8",
                          borderRadius: 12,
                          padding: "14px 18px",
                          fontSize: 15,
                          fontFamily: "inherit",
                          background: "#fff",
                          color: "#1a0505",
                        }}
                      />
                      <button
                        type="submit"
                        className="sub-btn"
                        disabled={freeLoading}
                        style={{
                          background: RED,
                          color: "#fff",
                          border: "none",
                          borderRadius: 12,
                          padding: "15px 24px",
                          fontSize: 15,
                          fontWeight: 700,
                          cursor: freeLoading ? "wait" : "pointer",
                        }}
                      >
                        {freeLoading ? t("free.sending") : t("free.signUp")}
                      </button>
                    </form>
                  )}
                  {freeError && (
                    <div
                      style={{ color: "#c0392b", fontSize: 13, marginTop: 10 }}
                    >
                      {freeError}
                    </div>
                  )}
                  <p
                    style={{
                      fontSize: 13,
                      color: "#888",
                      margin: "16px 0 0",
                      lineHeight: 1.5,
                    }}
                  >
                    {t("free.noCard")}{" "}
                    <a
                      href={`${import.meta.env.BASE_URL}course`}
                      style={{
                        color: RED,
                        fontWeight: 700,
                        textDecoration: "none",
                      }}
                    >
                      {t("free.course")}
                    </a>{" "}
                    {t("free.noCardSuffix")}
                  </p>
                </div>
              )}
              {!freeMode && (
                <>
                  {/* Hero */}
                  <div style={{ textAlign: "center", marginBottom: 40 }}>
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: ".14em",
                        textTransform: "uppercase",
                        color: RED,
                        marginBottom: 14,
                      }}
                    >
                      {t("hero.badge")}
                    </div>
                    <h1
                      style={{
                        fontSize: "clamp(30px, 5.4vw, 50px)",
                        fontWeight: 700,
                        color: "#1a0505",
                        lineHeight: 1.1,
                        letterSpacing: "-0.025em",
                        marginBottom: 18,
                        fontFamily: "'Georgia', 'Times New Roman', serif",
                      }}
                    >
                      {t("hero.headline1")}
                      <br />
                      {t("hero.headline2")}
                    </h1>
                    <p
                      style={{
                        fontSize: 18,
                        color: "#1a0505",
                        fontWeight: 600,
                        fontFamily: "'Georgia', 'Times New Roman', serif",
                        fontStyle: "italic",
                        lineHeight: 1.5,
                        maxWidth: 600,
                        margin: "0 auto 12px",
                      }}
                    >
                      {t("hero.intro")}
                    </p>
                    <p
                      style={{
                        fontSize: 17,
                        color: "#665",
                        lineHeight: 1.6,
                        maxWidth: 600,
                        margin: "0 auto",
                      }}
                    >
                      {t("hero.scienceSignedIntro", { name: SCIENCE_SIGNED })}{" "}
                      {t("hero.description")}
                    </p>
                  </div>

                  {/* Two-column: value on the left, pricing card on the right */}
                  <div className="sub-grid">
                    {/* Left — what you're paying for */}
                    <div>
                      <SectionLabel align="left">
                        {t("valuePoints.sectionLabel")}
                      </SectionLabel>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 22,
                        }}
                      >
                        {Array.isArray(valueItems) &&
                          valueItems.map((item) => (
                            <div
                              key={item.h}
                              style={{ display: "flex", gap: 14 }}
                            >
                              <span
                                style={{
                                  color: RED,
                                  fontWeight: 800,
                                  fontSize: 16,
                                  lineHeight: 1.35,
                                  flexShrink: 0,
                                }}
                              >
                                ✓
                              </span>
                              <div>
                                <div
                                  style={{
                                    fontSize: 16.5,
                                    fontWeight: 700,
                                    color: "#1a0505",
                                    fontFamily: "'Georgia', serif",
                                    marginBottom: 5,
                                    lineHeight: 1.3,
                                  }}
                                >
                                  {item.h}
                                </div>
                                <div
                                  style={{
                                    fontSize: 14,
                                    color: "#6a5555",
                                    lineHeight: 1.62,
                                  }}
                                >
                                  {item.p}
                                </div>
                              </div>
                            </div>
                          ))}
                      </div>

                      {/* Pillar grid */}
                      <div style={{ marginTop: 34 }}>
                        <SectionLabel align="left">
                          {t("pillarsGrid.sectionLabel")}
                        </SectionLabel>
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "1fr 1fr 1fr",
                            gap: 8,
                          }}
                        >
                          {Array.isArray(pillarsItems) &&
                            pillarsItems.map((name, i) => {
                              const meta = PILLARS_ICONS[i] ?? { icon: "✦" };
                              return (
                                <div
                                  key={name}
                                  style={{
                                    background: meta.soon
                                      ? "rgba(139,26,26,0.04)"
                                      : "#fff",
                                    border: `1px solid ${meta.soon ? "rgba(139,26,26,0.12)" : "#efe4e4"}`,
                                    borderRadius: 12,
                                    padding: "10px 12px",
                                    display: "flex",
                                    alignItems: "flex-start",
                                    gap: 8,
                                  }}
                                >
                                  <span style={{ fontSize: 16, lineHeight: 1 }}>
                                    {meta.icon}
                                  </span>
                                  <div>
                                    <div
                                      style={{
                                        fontSize: 12.5,
                                        fontWeight: 700,
                                        color: meta.soon
                                          ? "#9a7070"
                                          : "#1a0505",
                                        lineHeight: 1.3,
                                      }}
                                    >
                                      {name}
                                    </div>
                                    {meta.soon && (
                                      <div
                                        style={{
                                          fontSize: 10.5,
                                          color: RED,
                                          fontWeight: 600,
                                          marginTop: 2,
                                        }}
                                      >
                                        {t("pillarsGrid.comingSoon")}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                        </div>
                      </div>

                      <div style={{ marginTop: 34 }}>
                        <SectionLabel align="left">
                          {t("testimonials.sectionLabel")}
                        </SectionLabel>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 14,
                          }}
                        >
                          {getSleepTestimonials(i18n.language).map(
                            (testimonial) => (
                              <div
                                key={testimonial.name}
                                style={{
                                  background: "#fff",
                                  border: "1px solid #efe4e4",
                                  borderRadius: 14,
                                  padding: "16px 18px",
                                }}
                              >
                                <div
                                  style={{
                                    fontSize: 14.5,
                                    color: "#3d2a2a",
                                    fontFamily: "'Georgia', serif",
                                    fontStyle: "italic",
                                    lineHeight: 1.6,
                                    marginBottom: 8,
                                  }}
                                >
                                  "{testimonial.quote}"
                                </div>
                                <div
                                  style={{
                                    fontSize: 12.5,
                                    color: "#9a7f7f",
                                    fontWeight: 600,
                                  }}
                                >
                                  {testimonial.name} · {testimonial.detail}
                                </div>
                              </div>
                            ),
                          )}
                        </div>
                      </div>
                      <div
                        style={{
                          marginTop: 26,
                          paddingTop: 20,
                          borderTop: "1px solid rgba(139,26,26,.08)",
                          fontSize: 13.5,
                          color: "#8a6a6a",
                          lineHeight: 1.6,
                        }}
                      >
                        {t("testimonials.curiousPrefix")}{" "}
                        <a
                          href={`${import.meta.env.BASE_URL}sleep`}
                          style={{
                            color: RED,
                            fontWeight: 700,
                            textDecoration: "none",
                          }}
                        >
                          {t("testimonials.curiousLink")}
                        </a>{" "}
                        {t("testimonials.curiousSuffix")}
                      </div>
                    </div>

                    {/* Right — pricing card */}
                    <div>
                      <div
                        className="sub-pricecard"
                        style={{
                          background: "#fff",
                          border: "1.5px solid #e7dcdc",
                          borderRadius: 22,
                          overflow: "hidden",
                          boxShadow: "0 22px 50px rgba(139,26,26,0.10)",
                        }}
                      >
                        <div style={{ height: 4, background: RED }} />
                        <div style={{ padding: "26px 26px 28px" }}>
                          {/* Card header */}
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 11,
                              marginBottom: 4,
                            }}
                          >
                            <MoonMark />
                            <div
                              style={{
                                fontSize: 21,
                                fontWeight: 700,
                                color: "#1a0505",
                                fontFamily: "'Georgia', serif",
                              }}
                            >
                              {t("card.name")}
                            </div>
                          </div>
                          <div
                            style={{
                              fontSize: 13.5,
                              color: "#8a6a6a",
                              marginBottom: 20,
                              paddingLeft: 37,
                            }}
                          >
                            {t("card.tagline")}
                          </div>

                          {/* Billing toggle */}
                          {hasAnnual && (
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "center",
                                marginBottom: 22,
                              }}
                            >
                              <div
                                style={{
                                  display: "inline-flex",
                                  background: "#f2eded",
                                  borderRadius: 999,
                                  padding: 4,
                                  width: "100%",
                                }}
                              >
                                {(["monthly", "annual"] as const).map((b) => (
                                  <button
                                    key={b}
                                    type="button"
                                    onClick={() => {
                                      setBilling(b);
                                      setSelectedPriceId("");
                                    }}
                                    style={{
                                      flex: 1,
                                      appearance: "none",
                                      border: "none",
                                      cursor: "pointer",
                                      background:
                                        billing === b ? "#fff" : "transparent",
                                      color: billing === b ? RED : "#8a6a6a",
                                      fontWeight: 700,
                                      fontSize: 13.5,
                                      padding: "9px 14px",
                                      borderRadius: 999,
                                      boxShadow:
                                        billing === b
                                          ? "0 1px 4px rgba(0,0,0,0.1)"
                                          : "none",
                                      transition: "background .15s, color .15s",
                                    }}
                                  >
                                    {b === "monthly"
                                      ? t("billing.monthly")
                                      : t("billing.annual")}
                                    {b === "monthly" && (
                                      <span
                                        style={{
                                          marginLeft: 6,
                                          fontSize: 11,
                                          color: RED,
                                        }}
                                      >
                                        {t("billing.mostPopular")}
                                      </span>
                                    )}
                                    {b === "annual" && (
                                      <span
                                        style={{
                                          marginLeft: 6,
                                          fontSize: 11,
                                          color: "#2c5e2c",
                                        }}
                                      >
                                        {t("billing.savePct")}
                                      </span>
                                    )}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Per-tier plan cards — one card per tool tier with translated interval labels */}
                          {toolTiers.length > 1 && (
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 8,
                                marginBottom: 20,
                              }}
                            >
                              {toolTiers.map((tier) => {
                                const price = priceForTier(tier);
                                if (!price) return null;
                                const isSel = selectedPriceId === price.priceId;
                                return (
                                  <button
                                    key={tier.key}
                                    type="button"
                                    onClick={() =>
                                      setSelectedPriceId(price.priceId)
                                    }
                                    style={{
                                      display: "flex",
                                      justifyContent: "space-between",
                                      alignItems: "center",
                                      padding: "11px 14px",
                                      borderRadius: 12,
                                      border: isSel
                                        ? `2px solid ${RED}`
                                        : "1.5px solid #e7dcdc",
                                      background: isSel ? "#fff8f8" : "#fff",
                                      cursor: "pointer",
                                      textAlign: "left",
                                      width: "100%",
                                      transition:
                                        "border-color .15s, background .15s",
                                    }}
                                  >
                                    <span
                                      style={{
                                        fontSize: 14,
                                        fontWeight: 600,
                                        color: "#1a0505",
                                      }}
                                    >
                                      {t(`tiers.${tier.key}.title`, {
                                        defaultValue: tier.name ?? tier.key,
                                      })}
                                    </span>
                                    <span
                                      style={{
                                        fontSize: 13.5,
                                        color: "#666",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      {price.unitAmount !== undefined &&
                                        formatPrice(
                                          price.unitAmount,
                                          price.currency,
                                        )}
                                      {price.interval === "year"
                                        ? t("billing.perYear")
                                        : t("billing.perMonth")}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          )}

                          {plansLoading ? (
                            <div
                              style={{
                                color: "#999",
                                fontSize: 14,
                                textAlign: "center",
                                padding: "26px 0",
                              }}
                            >
                              {t("card.loadingPlans")}
                            </div>
                          ) : (
                            <>
                              {leadPrice && (
                                <>
                                  <div
                                    style={{
                                      display: "flex",
                                      alignItems: "baseline",
                                      gap: 6,
                                    }}
                                  >
                                    <span
                                      style={{
                                        fontSize: 42,
                                        fontWeight: 800,
                                        color: "#1a0505",
                                        letterSpacing: "-0.02em",
                                      }}
                                    >
                                      {formatPrice(
                                        leadPrice.unitAmount,
                                        leadPrice.currency,
                                      )}
                                    </span>
                                    <span
                                      style={{ fontSize: 15, color: "#999" }}
                                    >
                                      {leadPrice.interval === "year"
                                        ? t("billing.perYear")
                                        : t("billing.perMonth")}
                                    </span>
                                  </div>
                                  <div
                                    style={{
                                      fontSize: 13,
                                      color: "#9a8585",
                                      marginTop: 4,
                                      marginBottom: 22,
                                      minHeight: 18,
                                    }}
                                  >
                                    {leadPrice.interval === "year"
                                      ? `${perMonthEquivalent(
                                          leadPrice.unitAmount,
                                          leadPrice.currency,
                                        )}${t("card.billedAnnually")}`
                                      : t("card.billedMonthly")}
                                  </div>
                                </>
                              )}

                              {/* Includes */}
                              <ul
                                style={{
                                  listStyle: "none",
                                  margin: "0 0 24px",
                                  padding: 0,
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: 11,
                                }}
                              >
                                {(Array.isArray(
                                  leadTier?.key === "all_access"
                                    ? allAccessIncludes
                                    : nightlyIncludes,
                                )
                                  ? leadTier?.key === "all_access"
                                    ? allAccessIncludes
                                    : nightlyIncludes
                                  : []
                                ).map((inc) => (
                                  <li
                                    key={inc}
                                    style={{
                                      display: "flex",
                                      gap: 10,
                                      fontSize: 14,
                                      color: "#4a3535",
                                      lineHeight: 1.45,
                                    }}
                                  >
                                    <span
                                      style={{ color: RED, fontWeight: 700 }}
                                    >
                                      ✓
                                    </span>
                                    {inc}
                                  </li>
                                ))}
                              </ul>

                              {!leadPrice ? (
                                <div
                                  style={{
                                    fontSize: 13.5,
                                    color: "#8a6a6a",
                                    textAlign: "center",
                                    lineHeight: 1.6,
                                    padding: "6px 0 2px",
                                  }}
                                >
                                  {t("card.noPrice.prefix")}{" "}
                                  <a
                                    href={`${import.meta.env.BASE_URL}sleep`}
                                    style={{ color: RED, fontWeight: 700 }}
                                  >
                                    {t("card.noPrice.link")}
                                  </a>{" "}
                                  {t("card.noPrice.suffix")}
                                </div>
                              ) : (
                                <form
                                  onSubmit={handleCheckout}
                                  style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: 12,
                                  }}
                                >
                                  <input
                                    className="sub-input"
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder={t("card.emailPlaceholder")}
                                    required
                                    style={{
                                      border: "1.5px solid #e2d8d8",
                                      borderRadius: 12,
                                      padding: "14px 18px",
                                      fontSize: 15,
                                      fontFamily: "inherit",
                                      background: "#fff",
                                      color: "#1a0505",
                                      transition: "border-color .15s",
                                    }}
                                  />
                                  {error && (
                                    <div
                                      style={{ color: "#c0392b", fontSize: 13 }}
                                    >
                                      {error}
                                    </div>
                                  )}
                                  <button
                                    type="submit"
                                    className="sub-btn"
                                    disabled={loading || !selectedPriceId}
                                    style={{
                                      background: RED,
                                      color: "#fff",
                                      border: "none",
                                      borderRadius: 12,
                                      padding: "16px 24px",
                                      fontSize: 15.5,
                                      fontWeight: 700,
                                      cursor: loading ? "wait" : "pointer",
                                      letterSpacing: ".01em",
                                      opacity:
                                        loading || !selectedPriceId ? 0.7 : 1,
                                      transition: "opacity .15s",
                                    }}
                                  >
                                    {loading
                                      ? t("card.redirecting")
                                      : t("card.subscribe")}
                                  </button>
                                  <p
                                    style={{
                                      fontSize: 12,
                                      color: "#b3a3a3",
                                      margin: 0,
                                      textAlign: "center",
                                    }}
                                  >
                                    {t("card.secure")}
                                  </p>
                                  <ConsentLine action="subscribing" />
                                </form>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Returning subscriber sign-in */}
              <div
                style={{
                  marginTop: 36,
                  paddingTop: 22,
                  borderTop: "1px solid rgba(139,26,26,.07)",
                  textAlign: "center",
                }}
              >
                {!showSignIn ? (
                  <button
                    onClick={() => setShowSignIn(true)}
                    style={{
                      background: "none",
                      border: "none",
                      color: RED,
                      fontSize: 13.5,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {t("signIn.trigger")}
                  </button>
                ) : signInSent ? (
                  <div style={{ fontSize: 14, color: "#2c5e2c" }}>
                    {t("signIn.checkInbox")}
                  </div>
                ) : (
                  <form
                    onSubmit={handleSignInRequest}
                    style={{
                      display: "flex",
                      gap: 8,
                      flexWrap: "wrap",
                      justifyContent: "center",
                      maxWidth: 420,
                      margin: "0 auto",
                    }}
                  >
                    <input
                      className="sub-input"
                      type="email"
                      value={signInEmail}
                      onChange={(e) => setSignInEmail(e.target.value)}
                      placeholder={t("signIn.emailPlaceholder")}
                      required
                      style={{
                        flex: 1,
                        minWidth: 200,
                        border: "1.5px solid #e2d8d8",
                        borderRadius: 10,
                        padding: "11px 14px",
                        fontSize: 14,
                        fontFamily: "inherit",
                        background: "#fff",
                        color: "#1a0505",
                      }}
                    />
                    <button
                      type="submit"
                      className="sub-btn"
                      disabled={loading}
                      style={{
                        background: "#fff",
                        color: RED,
                        border: "1.5px solid #e2d8d8",
                        borderRadius: 10,
                        padding: "11px 18px",
                        fontSize: 14,
                        fontWeight: 700,
                        cursor: loading ? "wait" : "pointer",
                      }}
                    >
                      {t("signIn.sendLink")}
                    </button>
                  </form>
                )}
                {showSignIn && !signInSent && (
                  <ConsentLine action="signing in" style={{ marginTop: 12 }} />
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
