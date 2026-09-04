import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { SLMBrand } from "../components/SLMBrand";
import { ConsentLine } from "../components/consent-line";
import { destinationWithPendingQuestion } from "../lib/pending-question";

const API_BASE = "/api";
const RED = "#8B1A1A";
const PAPER = "#fafaf7";

type Capability = "nightly" | "newsletter";

interface PaidSubscription {
  subscriptionId: string;
  status: string | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  productName: string | null;
  palonurPlan: string | null;
  unitAmount: number | null;
  currency: string | null;
  interval: string | null;
  intervalCount?: number | null;
  plan: "monthly" | "annual" | null;
  stewardPublicationSlug?: string | null;
  stewardPublicationName?: string | null;
}

interface Publication {
  id?: number;
  publicationId?: number;
  name: string;
  slug: string;
  tagline: string | null;
  accentColor: string | null;
  isHouse: boolean;
  subscribedAt?: string | null;
}

interface AccountData {
  email: string;
  displayName: string | null;
  capabilities: Capability[];
  paidSubscriptions: PaidSubscription[];
  newsletterMemberships: Publication[];
  availablePublications: Publication[];
}

// The capabilities surfaced as "what you can access" content tiles.
type ToolCapability = "nightly" | "newsletter";

const CAPABILITY_HREF: Record<ToolCapability, string> = {
  nightly: "sleep",
  newsletter: "members",
};

const ALL_CAPABILITIES: ToolCapability[] = ["nightly", "newsletter"];

interface BillingPlan {
  priceId: string;
  productId: string;
  planKey: string | null;
  plan: "monthly" | "annual" | null;
  unitAmount: number | null;
  currency: string | null;
  interval: string | null;
}

type BillingInterval = "day" | "week" | "month" | "year";

const KNOWN_BILLING_INTERVALS: ReadonlySet<string> = new Set<BillingInterval>([
  "day",
  "week",
  "month",
  "year",
]);

function isBillingInterval(v: string): v is BillingInterval {
  return KNOWN_BILLING_INTERVALS.has(v);
}

function assertNeverInterval(x: never): string {
  if (import.meta.env.DEV) {
    console.warn(`[account] Unknown Stripe billing interval: ${String(x)}`);
  }
  return String(x);
}

function formatIntervalLabel(
  interval: BillingInterval,
  plural: boolean,
  t: (key: string, fallback: string) => string,
): string {
  switch (interval) {
    case "day":
    case "week":
    case "month":
    case "year":
      return t(
        `billing.intervalLabels.${interval}.${plural ? "plural" : "singular"}`,
        plural ? `${interval}s` : interval,
      );
    default:
      return assertNeverInterval(interval);
  }
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

export default function Account() {
  const { t } = useTranslation("account");
  const [data, setData] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Magic-link sign-in (when not authenticated).
  const [signInEmail, setSignInEmail] = useState("");
  const [signInSent, setSignInSent] = useState(false);

  // Live billing catalog — best-effort.
  const [billingPlans, setBillingPlans] = useState<BillingPlan[]>([]);

  useEffect(() => {
    async function loadPlans() {
      try {
        const res = await fetch(`${API_BASE}/billing/plans`);
        if (res.ok) {
          const json = (await res.json()) as { plans?: BillingPlan[] };
          setBillingPlans(json.plans ?? []);
        }
      } catch {
        /* card renders from static metadata without a price */
      }
    }
    void loadPlans();
  }, []);

  const loadAccount = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/account`, {
        credentials: "include",
      });
      if (res.status === 401) {
        setAuthed(false);
        setData(null);
        return;
      }
      if (res.ok) {
        setData((await res.json()) as AccountData);
        setAuthed(true);
      }
    } catch {
      /* leave as-is */
    } finally {
      setLoading(false);
    }
  }, []);

  // Bootstrap: consume a magic-link token if present, then load the account.
  useEffect(() => {
    document.title = t("title");
    const prevBg = document.body.style.background;
    document.body.style.background = PAPER;

    async function run() {
      const params = new URLSearchParams(window.location.search);
      const loginToken = params.get("login");
      const nextRaw = params.get("next");
      const next =
        nextRaw &&
        nextRaw.startsWith("/") &&
        !nextRaw.startsWith("//") &&
        !nextRaw.includes("\\")
          ? nextRaw
          : null;
      if (loginToken) {
        let signedIn = false;
        try {
          const res = await fetch(
            `${API_BASE}/consumer/auth/consume?token=${encodeURIComponent(loginToken)}`,
            { credentials: "include" },
          );
          signedIn = res.ok;
        } catch {
          /* ignore — loadAccount will reflect the real state */
        }
        window.history.replaceState({}, "", window.location.pathname);
        if (signedIn && next) {
          try {
            sessionStorage.setItem("palonur_demo_authed", "1");
          } catch {
            /* ignore */
          }
          window.location.href = destinationWithPendingQuestion(next);
          return;
        }
      }
      await loadAccount();
    }
    void run();

    return () => {
      document.body.style.background = prevBg;
    };
  }, [loadAccount, t]);

  async function handlePortal() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/billing/portal`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("error");
      const json = (await res.json()) as { url: string };
      window.location.href = json.url;
    } catch {
      setError("Couldn't open billing management just now — please try again.");
      setBusy(false);
    }
  }

  async function handleSignInRequest(e: React.FormEvent) {
    e.preventDefault();
    if (!signInEmail.trim()) return;
    setBusy(true);
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
      setBusy(false);
    }
  }

  async function handleLogout() {
    await fetch(`${API_BASE}/consumer/auth/logout`, {
      method: "POST",
      credentials: "include",
    }).catch(() => {});
    setAuthed(false);
    setData(null);
  }

  async function handleUnsubscribe(publicationId: number | undefined) {
    if (!publicationId) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(
        `${API_BASE}/account/newsletters/${publicationId}/unsubscribe`,
        { method: "POST", credentials: "include" },
      );
      if (!res.ok) throw new Error("error");
      await loadAccount();
    } catch {
      setError("Could not update that subscription.");
    } finally {
      setBusy(false);
    }
  }

  const capabilities = new Set(data?.capabilities ?? []);
  const hasAllAccess = ALL_CAPABILITIES.every((c) => capabilities.has(c));

  // Live All-Access price for the upgrade card (monthly preferred).
  const upgradePrice = (() => {
    const allAccess = billingPlans.filter((p) => p.planKey === "all_access");
    return (
      allAccess.find((p) => p.plan === "monthly") ??
      allAccess.find((p) => p.plan === "annual") ??
      null
    );
  })();

  // Locale-driven upgrade metadata
  const upgradeIncludes = t("upgradeCard.includes", {
    returnObjects: true,
  }) as string[];

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: PAPER,
        fontFamily: "'Inter', -apple-system, system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <style>{`
        @keyframes fadeUp { from { opacity:0; transform:translateY(16px);} to { opacity:1; transform:translateY(0);} }
        .acct-btn:hover:not(:disabled) { opacity: 0.88; }
        .acct-input:focus { border-color: rgba(139,26,26,.5) !important; outline: none; }
      `}</style>

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
          href={`${import.meta.env.BASE_URL}subscribe`}
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: RED,
            textDecoration: "none",
          }}
        >
          {t("capabilities.upgrade")}
        </a>
      </header>

      <main
        style={{
          flex: 1,
          display: "flex",
          justifyContent: "center",
          padding: "48px 24px",
        }}
      >
        <div
          style={{
            maxWidth: 620,
            width: "100%",
            animation: "fadeUp .5s ease both",
          }}
        >
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
            {t("headline")}
          </div>

          {loading || authed === null ? (
            <div style={{ color: "#999", fontSize: 14 }}>{t("loading")}</div>
          ) : !authed ? (
            /* ── Signed-out: magic-link sign in ─────────────────────────── */
            <div>
              <h1
                style={{
                  fontSize: "clamp(26px, 5vw, 36px)",
                  fontWeight: 700,
                  color: "#1a0505",
                  lineHeight: 1.18,
                  letterSpacing: "-0.02em",
                  marginBottom: 12,
                  fontFamily: "'Georgia', 'Times New Roman', serif",
                }}
              >
                {t("signInHeadline")}
              </h1>
              <p
                style={{
                  fontSize: 15,
                  color: "#666",
                  lineHeight: 1.6,
                  marginBottom: 24,
                }}
              >
                {t("signInBody")}
              </p>
              {signInSent ? (
                <div
                  style={{
                    background: "#f0f6ef",
                    color: "#2c5e2c",
                    border: "1px solid #cfe3cd",
                    borderRadius: 10,
                    padding: "12px 16px",
                    fontSize: 14,
                  }}
                >
                  {t("checkInbox")}
                </div>
              ) : (
                <form
                  onSubmit={handleSignInRequest}
                  style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
                >
                  <input
                    className="acct-input"
                    type="email"
                    value={signInEmail}
                    onChange={(e) => setSignInEmail(e.target.value)}
                    placeholder={t("signInEmailPlaceholder")}
                    required
                    style={{
                      flex: 1,
                      minWidth: 220,
                      border: "1.5px solid #e2d8d8",
                      borderRadius: 10,
                      padding: "13px 16px",
                      fontSize: 15,
                      fontFamily: "inherit",
                      background: "#fff",
                      color: "#1a0505",
                    }}
                  />
                  <button
                    type="submit"
                    className="acct-btn"
                    disabled={busy}
                    style={{
                      background: RED,
                      color: "#fff",
                      border: "none",
                      borderRadius: 10,
                      padding: "13px 22px",
                      fontSize: 14,
                      fontWeight: 700,
                      cursor: busy ? "wait" : "pointer",
                    }}
                  >
                    {t("sendLinkBtn")}
                  </button>
                </form>
              )}
              {!signInSent && (
                <ConsentLine
                  action="signing in"
                  align="left"
                  style={{ marginTop: 12 }}
                />
              )}
              {error && (
                <div style={{ color: "#c0392b", fontSize: 13, marginTop: 12 }}>
                  {error}
                </div>
              )}
            </div>
          ) : (
            /* ── Signed-in: manage ──────────────────────────────────────── */
            <div>
              <h1
                style={{
                  fontSize: "clamp(24px, 5vw, 34px)",
                  fontWeight: 700,
                  color: "#1a0505",
                  lineHeight: 1.18,
                  letterSpacing: "-0.02em",
                  marginBottom: 6,
                  fontFamily: "'Georgia', 'Times New Roman', serif",
                }}
              >
                {hasAllAccess ? t("allAccess") : t("yourSubscriptions")}
              </h1>
              <p style={{ fontSize: 14, color: "#888", marginBottom: 28 }}>
                {t("signedInAs")} <strong>{data?.email}</strong>.
              </p>
              {error && (
                <div
                  style={{ color: "#c0392b", fontSize: 13, marginBottom: 16 }}
                >
                  {error}
                </div>
              )}

              {/* Your name */}
              <NameSection
                displayName={data?.displayName ?? null}
                onSaved={loadAccount}
              />

              {/* How we reach you */}
              <NotificationsSection />

              {/* Paid plans */}
              <SectionLabel>{t("billing.sectionLabel")}</SectionLabel>
              {data && data.paidSubscriptions.length > 0 ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                    marginBottom: 16,
                  }}
                >
                  {data.paidSubscriptions.map((s) => (
                    <div
                      key={s.subscriptionId}
                      style={{
                        background: "#fff",
                        border: "1px solid #e2d8d8",
                        borderRadius: 12,
                        padding: "14px 16px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "baseline",
                          gap: 12,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 15,
                            fontWeight: 700,
                            color: "#1a0505",
                          }}
                        >
                          {s.productName ?? t("billing.subscription")}
                        </div>
                        <div style={{ fontSize: 14, color: "#555" }}>
                          {formatPrice(s.unitAmount, s.currency)}
                          {s.interval
                            ? (() => {
                                const raw = s.interval;
                                const iv = isBillingInterval(raw) ? raw : null;
                                if (!iv) {
                                  console.warn(
                                    `[account] Unknown Stripe billing interval: ${raw}`,
                                  );
                                }
                                const label = iv
                                  ? formatIntervalLabel(
                                      iv,
                                      !!(
                                        s.intervalCount && s.intervalCount > 1
                                      ),
                                      t,
                                    )
                                  : raw;
                                return s.intervalCount && s.intervalCount > 1
                                  ? " " +
                                      t("billing.everyN", {
                                        count: s.intervalCount,
                                        interval: label,
                                      })
                                  : " " +
                                      t("billing.perInterval", {
                                        interval: label,
                                      });
                              })()
                            : ""}
                        </div>
                      </div>
                      <div
                        style={{ fontSize: 12.5, color: "#999", marginTop: 4 }}
                      >
                        {s.cancelAtPeriodEnd
                          ? t("billing.cancels")
                          : s.status === "trialing"
                            ? t("billing.trialEnds")
                            : t("billing.renews")}
                        {s.currentPeriodEnd
                          ? ` ${new Date(s.currentPeriodEnd * 1000).toLocaleDateString()}`
                          : ""}
                      </div>
                      {s.stewardPublicationSlug && (
                        <a
                          href={`/p/${s.stewardPublicationSlug}`}
                          data-testid={`steward-sub-link-${s.stewardPublicationSlug}`}
                          style={{
                            display: "inline-block",
                            marginTop: 8,
                            fontSize: 13.5,
                            fontWeight: 700,
                            color: RED,
                            textDecoration: "none",
                          }}
                        >
                          {t("billing.askQuestion")}{" "}
                          {s.stewardPublicationName ?? "your steward"}
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p
                  style={{
                    fontSize: 14,
                    color: "#888",
                    marginBottom: 16,
                    lineHeight: 1.6,
                  }}
                >
                  {t("billing.freeTier")}
                </p>
              )}

              <div
                style={{
                  display: "flex",
                  gap: 12,
                  flexWrap: "wrap",
                  marginBottom: 32,
                }}
              >
                {data && data.paidSubscriptions.length > 0 && (
                  <button
                    onClick={handlePortal}
                    disabled={busy}
                    className="acct-btn"
                    style={{
                      background: "#fff",
                      color: RED,
                      border: "1.5px solid #e2d8d8",
                      borderRadius: 12,
                      padding: "12px 22px",
                      fontSize: 14,
                      fontWeight: 700,
                      cursor: busy ? "wait" : "pointer",
                    }}
                  >
                    {t("billing.manageBilling")}
                  </button>
                )}
              </div>

              {/* Upgrade card */}
              {!hasAllAccess && (
                <div
                  style={{
                    background: "#fff",
                    border: "1.5px solid #e2d8d8",
                    borderRadius: 14,
                    padding: "18px 20px",
                    marginBottom: 32,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 16,
                        fontWeight: 700,
                        color: "#1a0505",
                      }}
                    >
                      {t("upgradeCard.title")}
                    </div>
                    {upgradePrice && upgradePrice.unitAmount != null && (
                      <div style={{ fontSize: 14, color: "#555" }}>
                        <strong style={{ color: "#1a0505" }}>
                          {formatPrice(
                            upgradePrice.unitAmount,
                            upgradePrice.currency,
                          )}
                        </strong>{" "}
                        {upgradePrice.interval === "year"
                          ? t("billing.perYear")
                          : t("billing.perMonth")}
                      </div>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      color: "#888",
                      margin: "2px 0 12px",
                    }}
                  >
                    {t("upgradeCard.tagline")}
                  </div>
                  <ul
                    style={{
                      listStyle: "none",
                      margin: "0 0 16px",
                      padding: 0,
                      display: "flex",
                      flexDirection: "column",
                      gap: 7,
                    }}
                  >
                    {Array.isArray(upgradeIncludes) &&
                      upgradeIncludes.map((inc) => (
                        <li
                          key={inc}
                          style={{
                            display: "flex",
                            gap: 9,
                            fontSize: 13.5,
                            color: "#4a3535",
                            lineHeight: 1.45,
                          }}
                        >
                          <span style={{ color: RED, fontWeight: 700 }}>✓</span>
                          {inc}
                        </li>
                      ))}
                  </ul>
                  <a
                    href={`${import.meta.env.BASE_URL}subscribe`}
                    className="acct-btn"
                    style={{
                      display: "inline-block",
                      background: RED,
                      color: "#fff",
                      textDecoration: "none",
                      borderRadius: 12,
                      padding: "12px 22px",
                      fontSize: 14,
                      fontWeight: 700,
                    }}
                  >
                    {data && data.paidSubscriptions.length > 0
                      ? t("upgradeCard.cta")
                      : t("capabilities.upgrade")}
                  </a>
                </div>
              )}

              {/* Newsletter memberships */}
              <SectionLabel>{t("newsletters.sectionLabel")}</SectionLabel>
              {data && data.newsletterMemberships.length > 0 ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                    marginBottom: 16,
                  }}
                >
                  {data.newsletterMemberships.map((p) => (
                    <div
                      key={p.publicationId ?? p.id ?? p.slug}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        background: "#fff",
                        border: "1px solid #e2d8d8",
                        borderRadius: 12,
                        padding: "13px 16px",
                      }}
                    >
                      <div>
                        <div
                          style={{
                            fontSize: 14.5,
                            fontWeight: 700,
                            color: "#1a0505",
                          }}
                        >
                          {p.name}
                          {p.isHouse && (
                            <span
                              style={{
                                marginLeft: 8,
                                fontSize: 10.5,
                                fontWeight: 700,
                                color: RED,
                                background: "#f2dede",
                                padding: "2px 7px",
                                borderRadius: 8,
                                letterSpacing: ".04em",
                                textTransform: "uppercase",
                              }}
                            >
                              {t("newsletters.house")}
                            </span>
                          )}
                        </div>
                        {p.tagline && (
                          <div style={{ fontSize: 12.5, color: "#888" }}>
                            {p.tagline}
                          </div>
                        )}
                      </div>
                      <button
                        onClick={() =>
                          handleUnsubscribe(p.publicationId ?? p.id)
                        }
                        disabled={busy}
                        style={{
                          flexShrink: 0,
                          background: "none",
                          border: "none",
                          color: "#b0735a",
                          fontSize: 12.5,
                          fontWeight: 600,
                          cursor: busy ? "wait" : "pointer",
                          textDecoration: "underline",
                        }}
                      >
                        {t("newsletters.unsubscribe")}
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p
                  style={{
                    fontSize: 14,
                    color: "#888",
                    marginBottom: 16,
                    lineHeight: 1.6,
                  }}
                >
                  {t("newsletters.noNewsletters")}
                </p>
              )}

              <div
                style={{
                  display: "flex",
                  gap: 12,
                  flexWrap: "wrap",
                  marginBottom: 36,
                }}
              >
                <a
                  href={`${import.meta.env.BASE_URL}members`}
                  className="acct-btn"
                  style={{
                    display: "inline-block",
                    background: "#fff",
                    color: RED,
                    textDecoration: "none",
                    border: "1.5px solid #e2d8d8",
                    borderRadius: 12,
                    padding: "12px 22px",
                    fontSize: 14,
                    fontWeight: 700,
                  }}
                >
                  {t("newsletters.readingRoom")}
                </a>
                <a
                  href={`${import.meta.env.BASE_URL}newsletter`}
                  className="acct-btn"
                  style={{
                    display: "inline-block",
                    background: "#fff",
                    color: "#555",
                    textDecoration: "none",
                    border: "1.5px solid #e2d8d8",
                    borderRadius: 12,
                    padding: "12px 22px",
                    fontSize: 14,
                    fontWeight: 700,
                  }}
                >
                  {t("newsletters.browseNewsletters")}
                </a>
              </div>

              {/* Referral card */}
              <ReferralCard />

              {/* Data export & account deletion */}
              <YourDataSection
                onDeleted={() => {
                  setAuthed(false);
                  setData(null);
                }}
              />

              <button
                onClick={handleLogout}
                style={{
                  background: "none",
                  border: "none",
                  color: "#999",
                  fontSize: 13,
                  cursor: "pointer",
                  textDecoration: "underline",
                }}
              >
                {t("signOut")}
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

interface ReferralStatus {
  code: string | null;
  link: string;
  signups: number;
  conversions: number;
  creditsEarnedCents: number;
  bonusQuestionsRemaining: number;
}

function ReferralCard() {
  const [status, setStatus] = useState<ReferralStatus | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const r = await fetch(`${API_BASE}/referral/status`, {
          credentials: "include",
        });
        if (!r.ok) return;
        const d: ReferralStatus = await r.json();
        // If no code yet, lazy-create one then re-fetch status.
        if (!d.code) {
          const cr = await fetch(`${API_BASE}/referral/code`, {
            credentials: "include",
          });
          if (!cr.ok) return;
          const r2 = await fetch(`${API_BASE}/referral/status`, {
            credentials: "include",
          });
          if (!r2.ok) return;
          const d2: ReferralStatus = await r2.json();
          if (d2.link) setStatus(d2);
          return;
        }
        setStatus(d);
      } catch {
        /* ignore */
      }
    }
    void load();
  }, []);

  if (!status) return null;

  function copyLink() {
    navigator.clipboard
      .writeText(status!.link)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }

  return (
    <div style={{ marginBottom: 28 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: ".12em",
          textTransform: "uppercase",
          color: "#aaa",
          marginBottom: 12,
        }}
      >
        Share Palonur
      </div>
      <div
        style={{
          background: "linear-gradient(135deg, #fff8f0, #fff3e8)",
          border: "1px solid rgba(139,26,26,.15)",
          borderRadius: 14,
          padding: "18px 20px",
        }}
      >
        <div
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: "#1a0505",
            marginBottom: 4,
          }}
        >
          Give a friend 5 free questions. Earn a free month.
        </div>
        <div
          style={{
            fontSize: 13,
            color: "#8a6a5a",
            marginBottom: 14,
            lineHeight: 1.55,
          }}
        >
          Every time a friend signs up with your link and becomes a paid member,
          you get one month free on your subscription.
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            background: "#fff",
            border: "1.5px solid #e2d8d8",
            borderRadius: 10,
            padding: "10px 14px",
            marginBottom: 14,
            fontFamily: "monospace",
            fontSize: 13,
            color: "#572020",
            wordBreak: "break-all",
          }}
        >
          <span style={{ flex: 1 }}>{status.link}</span>
          <button
            onClick={copyLink}
            style={{
              flexShrink: 0,
              background: RED,
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "6px 14px",
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
              transition: "opacity .15s",
            }}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 20,
            fontSize: 13,
            color: "#8a6a5a",
          }}
        >
          <span>
            <strong style={{ color: "#1a0505" }}>{status.signups}</strong>{" "}
            {status.signups === 1 ? "signup" : "signups"}
          </span>
          <span>
            <strong style={{ color: "#1a0505" }}>{status.conversions}</strong>{" "}
            {status.conversions === 1 ? "paid member" : "paid members"}
          </span>
          {status.creditsEarnedCents > 0 && (
            <span style={{ color: "#2c5e2c", fontWeight: 600 }}>
              {status.conversions} free{" "}
              {status.conversions === 1 ? "month" : "months"} earned
            </span>
          )}
          {status.bonusQuestionsRemaining > 0 && (
            <span style={{ color: "#2c5e2c", fontWeight: 600 }}>
              {status.bonusQuestionsRemaining} bonus{" "}
              {status.bonusQuestionsRemaining === 1 ? "question" : "questions"}{" "}
              remaining
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Inline display-name editor — "what should we call you?". */
function NameSection({
  displayName,
  onSaved,
}: {
  displayName: string | null;
  onSaved: () => Promise<void> | void;
}) {
  const { t } = useTranslation("account");
  const [editing, setEditing] = useState(displayName == null);
  const [value, setValue] = useState(displayName ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    setValue(displayName ?? "");
    setEditing(displayName == null);
  }, [displayName]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(`${API_BASE}/account/name`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: value }),
      });
      if (!res.ok) throw new Error("error");
      await onSaved();
      setEditing(false);
    } catch {
      setErr(t("name.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBottom: 28 }}>
      <SectionLabel>{t("name.sectionLabel")}</SectionLabel>
      <div
        style={{
          background: "#fff",
          border: "1px solid #e2d8d8",
          borderRadius: 12,
          padding: "14px 16px",
        }}
      >
        {editing ? (
          <>
            <div
              style={{
                fontSize: 13.5,
                color: "#8a6a5a",
                lineHeight: 1.55,
                marginBottom: 10,
              }}
            >
              {t("name.prompt")}
            </div>
            <form
              onSubmit={save}
              style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
            >
              <input
                className="acct-input"
                type="text"
                maxLength={80}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={t("name.placeholder")}
                data-testid="account-name-input"
                style={{
                  flex: 1,
                  minWidth: 180,
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
                className="acct-btn"
                disabled={busy}
                data-testid="account-name-save"
                style={{
                  background: RED,
                  color: "#fff",
                  border: "none",
                  borderRadius: 10,
                  padding: "11px 20px",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: busy ? "wait" : "pointer",
                }}
              >
                {busy ? t("name.saving") : t("name.save")}
              </button>
            </form>
          </>
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <div style={{ fontSize: 14.5, fontWeight: 700, color: "#1a0505" }}>
              {displayName || t("name.notSet")}
            </div>
            <button
              type="button"
              onClick={() => setEditing(true)}
              data-testid="account-name-edit"
              style={{
                background: "none",
                border: "none",
                color: RED,
                fontSize: 13,
                fontWeight: 700,
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              {t("name.change")}
            </button>
          </div>
        )}
        {err && (
          <div style={{ fontSize: 12.5, color: "#c0392b", marginTop: 10 }}>
            {err}
          </div>
        )}
      </div>
    </div>
  );
}

function YourDataSection({ onDeleted }: { onDeleted: () => void }) {
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMsg, setExportMsg] = useState("");
  const [exportErr, setExportErr] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteErr, setDeleteErr] = useState("");
  const [deleted, setDeleted] = useState(false);

  async function handleExport() {
    setExportBusy(true);
    setExportErr("");
    setExportMsg("");
    try {
      const res = await fetch(`${API_BASE}/consumer/data-export`, {
        method: "POST",
        credentials: "include",
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setExportErr(
          d.error ?? "Couldn't send your export just now — try again later.",
        );
        return;
      }
      setExportMsg(
        "We've emailed a copy of your data to your account address.",
      );
    } catch {
      setExportErr("Couldn't send your export just now — try again later.");
    } finally {
      setExportBusy(false);
    }
  }

  async function handleDelete(e: React.FormEvent) {
    e.preventDefault();
    if (confirmText.trim().toUpperCase() !== "DELETE") {
      setDeleteErr("Type DELETE to confirm.");
      return;
    }
    setDeleteBusy(true);
    setDeleteErr("");
    try {
      const res = await fetch(`${API_BASE}/consumer/delete-account`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleteErr(d.error ?? "Deletion failed — please try again.");
        return;
      }
      setDeleted(true);
      window.setTimeout(onDeleted, 2500);
    } catch {
      setDeleteErr("Deletion failed — please try again.");
    } finally {
      setDeleteBusy(false);
    }
  }

  if (deleted) {
    return (
      <div style={{ marginBottom: 28 }}>
        <SectionLabel>Your data</SectionLabel>
        <div
          style={{
            background: "#f0f6ef",
            color: "#2c5e2c",
            border: "1px solid #cfe3cd",
            borderRadius: 12,
            padding: "14px 16px",
            fontSize: 14,
            lineHeight: 1.6,
          }}
          data-testid="account-deleted-notice"
        >
          Your account and personal data have been deleted. A confirmation email
          is on its way. Thank you for spending time with us.
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 28 }}>
      <SectionLabel>Your data</SectionLabel>
      <div
        style={{
          background: "#fff",
          border: "1px solid #e2d8d8",
          borderRadius: 12,
          padding: "16px 18px",
        }}
      >
        <div
          style={{
            fontSize: 13.5,
            color: "#8a6a5a",
            lineHeight: 1.6,
            marginBottom: 12,
          }}
        >
          You can get an emailed copy of everything we store about you —
          profile, subscriptions, and question history — or delete your account
          entirely. Details in our{" "}
          <a
            href={`${import.meta.env.BASE_URL}privacy`}
            style={{ color: RED, textDecoration: "underline" }}
          >
            privacy policy
          </a>
          .
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="acct-btn"
            onClick={handleExport}
            disabled={exportBusy}
            data-testid="account-export-data"
            style={{
              background: "#fff",
              color: "#572020",
              border: "1.5px solid #e2d8d8",
              borderRadius: 10,
              padding: "10px 18px",
              fontSize: 13,
              fontWeight: 700,
              cursor: exportBusy ? "wait" : "pointer",
            }}
          >
            {exportBusy ? "Sending…" : "Email me my data"}
          </button>
          {!confirming && (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              data-testid="account-delete-start"
              style={{
                background: "none",
                border: "none",
                color: "#b04030",
                fontSize: 13,
                fontWeight: 700,
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              Delete my account
            </button>
          )}
        </div>
        {exportMsg && (
          <div style={{ fontSize: 12.5, color: "#2c5e2c", marginTop: 10 }}>
            {exportMsg}
          </div>
        )}
        {exportErr && (
          <div style={{ fontSize: 12.5, color: "#c0392b", marginTop: 10 }}>
            {exportErr}
          </div>
        )}
        {confirming && (
          <form onSubmit={handleDelete} style={{ marginTop: 14 }}>
            <div
              style={{
                fontSize: 13,
                color: "#7a3a2a",
                lineHeight: 1.6,
                marginBottom: 10,
              }}
            >
              This permanently removes your email, name, phone number, and the
              link to your question history. Billing records we must keep are
              anonymized. Any active subscription should be cancelled first via
              “Manage billing”. Type <strong>DELETE</strong> to confirm.
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                className="acct-input"
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="DELETE"
                data-testid="account-delete-confirm-input"
                style={{
                  width: 120,
                  border: "1.5px solid #e2d8d8",
                  borderRadius: 10,
                  padding: "10px 14px",
                  fontSize: 14,
                  fontFamily: "inherit",
                  background: "#fff",
                  color: "#1a0505",
                }}
              />
              <button
                type="submit"
                className="acct-btn"
                disabled={deleteBusy}
                data-testid="account-delete-confirm"
                style={{
                  background: "#b04030",
                  color: "#fff",
                  border: "none",
                  borderRadius: 10,
                  padding: "10px 18px",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: deleteBusy ? "wait" : "pointer",
                }}
              >
                {deleteBusy ? "Deleting…" : "Delete my account"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  setConfirmText("");
                  setDeleteErr("");
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "#999",
                  fontSize: 13,
                  cursor: "pointer",
                  textDecoration: "underline",
                }}
              >
                Keep my account
              </button>
            </div>
            {deleteErr && (
              <div style={{ fontSize: 12.5, color: "#c0392b", marginTop: 10 }}>
                {deleteErr}
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: ".12em",
        textTransform: "uppercase",
        color: "#aaa",
        marginBottom: 12,
      }}
    >
      {children}
    </div>
  );
}

type NotificationChannel = "email" | "imessage" | "both";

interface NotificationProductPref {
  product: "nightly";
  channel: NotificationChannel;
  subscribed: boolean;
}

interface NotificationSettings {
  email: string;
  phone: {
    number: string | null;
    status: "active" | "pending" | "opted_out" | null;
  };
  products: NotificationProductPref[];
}

const PRODUCT_NAMES: Record<"nightly", string> = { nightly: "Pal" };

const CHANNELS: { value: NotificationChannel; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "imessage", label: "iMessage" },
  { value: "both", label: "Both" },
];

/**
 * "How we reach you" — per-product notification channel picker plus inline
 * phone add/verify. Self-contained: fetches its own settings so it never
 * complicates the main account load.
 */
function NotificationsSection() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [phoneInput, setPhoneInput] = useState("");
  const [consent, setConsent] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/account/notifications`, {
        credentials: "include",
      });
      if (res.ok) setSettings((await res.json()) as NotificationSettings);
    } catch {
      /* leave as-is */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const phoneConfirmed = settings?.phone.status === "active";

  const setChannel = async (
    product: "nightly",
    channel: NotificationChannel,
  ) => {
    setErr("");
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/account/notifications/${product}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ channel }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(d.error ?? "Couldn't update that — try again.");
        return;
      }
      setSettings(d as NotificationSettings);
    } catch {
      setErr("Couldn't update that — try again.");
    } finally {
      setBusy(false);
    }
  };

  const addPhone = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setMsg("");
    if (!phoneInput.trim()) return;
    if (!consent) {
      setErr("Please tick the consent box to receive texts.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/account/phone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ phone: phoneInput.trim(), consent: true }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(d.error ?? "Couldn't add that number — try again.");
        return;
      }
      if (d.alreadyConfirmed) {
        setMsg("That number is already confirmed.");
      } else if (d.pending) {
        setMsg(
          "If we can reach this number, you'll get a text with a link to confirm it.",
        );
      }
      setConsent(false);
      await load();
    } catch {
      setErr("Couldn't add that number — try again.");
    } finally {
      setBusy(false);
    }
  };

  if (loading || !settings) return null;

  const subscribed = settings.products.filter((p) => p.subscribed);
  if (subscribed.length === 0) return null;

  const phoneStatusLabel =
    settings.phone.status === "active"
      ? "Confirmed"
      : settings.phone.status === "pending"
        ? "Awaiting confirmation"
        : settings.phone.status === "opted_out"
          ? "Opted out (reply START or re-add to opt back in)"
          : null;

  return (
    <div style={{ marginBottom: 28 }}>
      <SectionLabel>How we reach you</SectionLabel>
      <p
        style={{
          fontSize: 13.5,
          color: "#8a6a5a",
          lineHeight: 1.55,
          margin: "0 0 14px",
        }}
      >
        Optional support for your experiments and nightly check-ins — gentle
        reminders and encouragement, your choice of email, text, or both. The
        answers on the sleep page always stay on the page; we never text those.
      </p>

      {/* Per-product channel pickers */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          marginBottom: 14,
        }}
      >
        {subscribed.map((p) => (
          <div
            key={p.product}
            style={{
              background: "#fff",
              border: "1px solid #e2d8d8",
              borderRadius: 12,
              padding: "13px 16px",
            }}
          >
            <div
              style={{
                fontSize: 14.5,
                fontWeight: 700,
                color: "#1a0505",
                marginBottom: 10,
              }}
            >
              {PRODUCT_NAMES[p.product]}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {CHANNELS.map((c) => {
                const needsPhone = c.value === "imessage" || c.value === "both";
                const disabled = busy || (needsPhone && !phoneConfirmed);
                const active = p.channel === c.value;
                return (
                  <button
                    key={c.value}
                    onClick={() => !active && setChannel(p.product, c.value)}
                    disabled={disabled}
                    title={
                      needsPhone && !phoneConfirmed
                        ? "Confirm a phone number to enable iMessage"
                        : undefined
                    }
                    style={{
                      background: active ? RED : "#fff",
                      color: active ? "#fff" : disabled ? "#bbb" : "#572020",
                      border: `1.5px solid ${active ? RED : "#e2d8d8"}`,
                      borderRadius: 9,
                      padding: "7px 16px",
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: disabled
                        ? "not-allowed"
                        : active
                          ? "default"
                          : "pointer",
                    }}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Phone number status + add/verify */}
      <div
        style={{
          background: "#faf7f4",
          border: "1px solid #ece6e0",
          borderRadius: 12,
          padding: "14px 16px",
        }}
      >
        {settings.phone.number ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <div style={{ fontSize: 13.5, color: "#572020" }}>
              <strong>{settings.phone.number}</strong>
              <span style={{ color: "#8a6a5a", marginLeft: 8 }}>
                {phoneStatusLabel}
              </span>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 13.5, color: "#8a6a5a", marginBottom: 10 }}>
            Add a phone number to get experiment and check-in support by text.
          </div>
        )}

        {settings.phone.status !== "active" && (
          <form onSubmit={addPhone} style={{ marginTop: 10 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                className="acct-input"
                type="tel"
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                placeholder="(555) 123-4567"
                style={{
                  flex: 1,
                  minWidth: 180,
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
                className="acct-btn"
                disabled={busy}
                style={{
                  background: RED,
                  color: "#fff",
                  border: "none",
                  borderRadius: 10,
                  padding: "11px 20px",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: busy ? "wait" : "pointer",
                }}
              >
                {settings.phone.status === "pending"
                  ? "Awaiting confirmation"
                  : "Add & verify"}
              </button>
            </div>
            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                marginTop: 10,
                fontSize: 12,
                color: "#8a6a5a",
                lineHeight: 1.5,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                style={{ marginTop: 2 }}
              />
              <span>
                I agree to receive texts from Palonur with support for my
                experiments and check-ins. Message &amp; data rates may apply.
                Reply STOP to opt out.
              </span>
            </label>
          </form>
        )}

        {msg && (
          <div style={{ fontSize: 12.5, color: "#2c5e2c", marginTop: 10 }}>
            {msg}
          </div>
        )}
        {err && (
          <div style={{ fontSize: 12.5, color: "#c0392b", marginTop: 10 }}>
            {err}
          </div>
        )}
      </div>
    </div>
  );
}
