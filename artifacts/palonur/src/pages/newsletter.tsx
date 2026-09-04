import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { ConsentLine } from "../components/consent-line";

const RED = "#8B1A1A";
const INK = "#0a0a0f";
const PAPER = "#FAF8F4";
const MUTED = "rgba(10,10,15,0.62)";
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif";

// The seven pillars of the Stanford Lifestyle Medicine program and their faculty
// stewards. This is a deliberate, curated editorial constant (the same pattern as
// the faculty landing page's LANDING_PILLARS) — the anonymous public pillars API
// stays steward-free; steward identity is named here only as published frontend
// copy. Pillar names mirror Stanford's public program; order follows it too.
const SLM_PILLARS: { pillar: string; steward: string }[] = [
  { pillar: "Movement & Exercise", steward: "Anne Friedlander" },
  { pillar: "Healthful Nutrition", steward: "Marily Oppezzo" },
  { pillar: "Restorative Sleep", steward: "Prof. Jamie Zeitzer" },
  { pillar: "Stress Management", steward: "Sarah Meyer Tapia" },
  { pillar: "Social Engagement", steward: "Steven Crane" },
  { pillar: "Cognitive Enhancement", steward: "Shaliza Shorey" },
  { pillar: "Gratitude & Purpose", steward: "Bruce Feldstein & Barbara Waxman" },
];

interface Plan {
  productId: string;
  priceId: string;
  name: string | null;
  description: string | null;
  unitAmount: number | null;
  currency: string | null;
  interval: string | null;
  plan: "monthly" | "annual" | null;
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

export default function Newsletter() {
  const { t } = useTranslation("newsletter");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">(
    "idle",
  );
  const [msg, setMsg] = useState("");
  const [, setLocation] = useLocation();

  // Premium upgrade state
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [selectedPriceId, setSelectedPriceId] = useState("");
  const [payEmail, setPayEmail] = useState("");
  const [payLoading, setPayLoading] = useState(false);
  const [payError, setPayError] = useState("");
  const [notice, setNotice] = useState("");
  const [highlightUpgrade, setHighlightUpgrade] = useState(false);

  // Manage-subscription (portal-by-email) state
  const [manageEmail, setManageEmail] = useState("");
  const [manageState, setManageState] = useState<
    "idle" | "loading" | "sent" | "error"
  >("idle");
  const [manageMsg, setManageMsg] = useState("");

  useEffect(() => {
    document.title = t("pageTitle");
    document.body.style.background = PAPER;
    const prevDesc = document
      .querySelector('meta[name="description"]')
      ?.getAttribute("content");
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "description");
      document.head.appendChild(meta);
    }
    meta.setAttribute(
      "content",
      "Sleep science you can use, plus real stories from our community — from Stanford Lifestyle Medicine and Palonur.",
    );
    return () => {
      document.body.style.background = "";
      if (prevDesc && meta) meta.setAttribute("content", prevDesc);
    };
  }, [t]);

  // ── Handle checkout return / portal token / upgrade deep-link ──────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get("checkout");
    const sessionId = params.get("session_id");
    const portalToken = params.get("portal");
    const upgrade = params.get("upgrade");

    function clearQuery() {
      window.history.replaceState({}, "", window.location.pathname);
    }

    async function run() {
      if (checkout === "success" && sessionId) {
        try {
          const res = await fetch("/api/newsletter/billing/confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId }),
          });
          if (res.ok) {
            setNotice(
              "You're a premium subscriber — full issues will land in your inbox. Thank you for supporting our work.",
            );
          } else {
            setNotice(
              "Payment received. If your first premium issue doesn't arrive, contact us and we'll sort it out.",
            );
          }
        } catch {
          setNotice("Payment received — welcome to premium.");
        }
        clearQuery();
        return;
      }
      if (checkout === "cancelled") {
        setNotice("Checkout cancelled — no charge was made.");
        clearQuery();
        return;
      }
      if (portalToken) {
        try {
          const res = await fetch("/api/newsletter/billing/portal/consume", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: portalToken }),
          });
          const d = await res.json().catch(() => ({}));
          if (res.ok && d.url) {
            window.location.href = d.url;
            return;
          }
          setNotice(
            d.error ?? "That link has expired. Request a new one below.",
          );
        } catch {
          setNotice("Could not open the billing portal. Request a new link.");
        }
        clearQuery();
        return;
      }
      if (upgrade) {
        setHighlightUpgrade(true);
        clearQuery();
        setTimeout(() => {
          document
            .getElementById("premium")
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 200);
      }
    }
    void run();
  }, []);

  // ── Load premium plans ─────────────────────────────────────────────────────
  useEffect(() => {
    async function loadPlans() {
      try {
        const res = await fetch("/api/newsletter/billing/plans");
        if (res.ok) {
          const data = (await res.json()) as { plans: Plan[] };
          setPlans(data.plans ?? []);
          const annual = data.plans?.find((p) => p.plan === "annual");
          setSelectedPriceId((annual ?? data.plans?.[0])?.priceId ?? "");
        }
      } catch {
        /* leave plans empty */
      } finally {
        setPlansLoading(false);
      }
    }
    void loadPlans();
  }, []);

  const sortedPlans = useMemo(
    // Anchor high: Annual ("Best value") leads, Monthly follows.
    () => [...plans].sort((a, b) => (b.unitAmount ?? 0) - (a.unitAmount ?? 0)),
    [plans],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setState("loading");
    setMsg("");
    try {
      const r = await fetch("/api/newsletter/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          name: name.trim() || undefined,
          source: "newsletter-page",
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setState("error");
        setMsg(d.error ?? t("form.errorFallback"));
        return;
      }
      setState("done");
      setLocation(
        `/newsletter/subscribed${d.alreadySubscribed ? "?already=1" : d.pending ? "?pending=1" : ""}`,
      );
    } catch {
      setState("error");
      setMsg(t("form.networkError"));
    }
  }

  async function handleCheckout(e: React.FormEvent) {
    e.preventDefault();
    if (!payEmail.trim() || !selectedPriceId) return;
    setPayLoading(true);
    setPayError("");
    try {
      const res = await fetch("/api/newsletter/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: payEmail.trim(),
          priceId: selectedPriceId,
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? "error");
      }
      const d = (await res.json()) as { url: string };
      window.location.href = d.url;
    } catch (err) {
      setPayError(
        err instanceof Error && err.message !== "error"
          ? err.message
          : t("premium.manageError"),
      );
      setPayLoading(false);
    }
  }

  async function handleManage(e: React.FormEvent) {
    e.preventDefault();
    if (!manageEmail.trim()) return;
    setManageState("loading");
    setManageMsg("");
    try {
      const res = await fetch("/api/newsletter/billing/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: manageEmail.trim() }),
      });
      if (!res.ok && res.status !== 200) throw new Error("error");
      setManageState("sent");
      setManageMsg(t("premium.manageMsg"));
    } catch {
      setManageState("error");
      setManageMsg(t("premium.manageError"));
    }
  }

  const whatYouGetItems = t("whatYouGet.items", { returnObjects: true }) as Array<{
    title: string;
    desc: string;
  }>;

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: PAPER,
        color: INK,
        fontFamily: SANS,
      }}
    >
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "72px 24px 96px" }}>
        <a
          href="/"
          style={{
            fontSize: 13,
            letterSpacing: ".04em",
            color: MUTED,
            textDecoration: "none",
          }}
        >
          {t("page.backLink")}
        </a>

        {notice && (
          <div
            style={{
              marginTop: 28,
              background: "#f0f6ef",
              color: "#2c5e2c",
              border: "1px solid #cfe3cd",
              borderRadius: 10,
              padding: "12px 16px",
              fontSize: 14,
            }}
          >
            {notice}
          </div>
        )}

        <img
          src={`${import.meta.env.BASE_URL}stanford-lifestyle-medicine-logo-transparent.png`}
          alt="Stanford Lifestyle Medicine"
          style={{
            marginTop: 40,
            display: "block",
            height: 34,
            width: "auto",
          }}
        />
        <h1
          style={{
            fontFamily: SERIF,
            fontWeight: 500,
            fontSize: "clamp(34px, 6vw, 52px)",
            lineHeight: 1.08,
            margin: "10px 0 0",
            letterSpacing: "-0.01em",
          }}
        >
          {t("page.name")}
        </h1>
        <p
          style={{
            fontFamily: SERIF,
            fontSize: 20,
            lineHeight: 1.6,
            color: MUTED,
            marginTop: 18,
          }}
        >
          {t("page.subline")}
        </p>

        <form
          onSubmit={submit}
          style={{
            marginTop: 36,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            maxWidth: 440,
          }}
        >
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("page.namePlaceholder")}
            disabled={state === "loading" || state === "done"}
            style={inputStyle}
          />
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("subscribe.emailPlaceholder")}
            disabled={state === "loading" || state === "done"}
            style={inputStyle}
          />
          <button
            type="submit"
            disabled={state === "loading" || state === "done"}
            style={{
              background: state === "done" ? "#2e7d32" : RED,
              color: "#fff",
              border: "none",
              borderRadius: 10,
              padding: "14px 18px",
              fontSize: 16,
              fontWeight: 600,
              cursor: state === "done" ? "default" : "pointer",
              fontFamily: SANS,
              opacity: state === "loading" ? 0.7 : 1,
              transition: "background .2s",
            }}
          >
            {state === "loading"
              ? t("form.subscribing")
              : state === "done"
                ? t("form.done")
                : t("form.default")}
          </button>
          <ConsentLine
            action="subscribing"
            color={MUTED}
            fontFamily={SANS}
            align="left"
          />
          {msg && (
            <p
              style={{
                fontSize: 14,
                color: state === "error" ? RED : "#2e7d32",
                margin: "4px 0 0",
              }}
            >
              {msg}
            </p>
          )}
        </form>

        <p style={{ fontSize: 13, color: MUTED, marginTop: 22, lineHeight: 1.6 }}>
          {t("page.noShare")}
        </p>

        <hr
          style={{
            border: "none",
            borderTop: "1px solid rgba(10,10,15,0.1)",
            margin: "56px 0 32px",
          }}
        />

        <h2
          style={{
            fontFamily: SERIF,
            fontWeight: 500,
            fontSize: 24,
            margin: "0 0 14px",
          }}
        >
          {t("whatYouGet.headline")}
        </h2>
        <ul
          style={{
            margin: 0,
            paddingLeft: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          {whatYouGetItems.map((item) => (
            <li key={item.title}>
              <p style={{ fontWeight: 600, fontSize: 16, margin: 0 }}>{item.title}</p>
              <p style={{ color: MUTED, fontSize: 15, margin: "4px 0 0", lineHeight: 1.6 }}>
                {item.desc}
              </p>
            </li>
          ))}
        </ul>

        {/* ── Stewards & pillars ───────────────────────────────────────────── */}
        <hr
          style={{
            border: "none",
            borderTop: "1px solid rgba(10,10,15,0.1)",
            margin: "56px 0 32px",
          }}
        />
        <p
          style={{
            fontSize: 12,
            letterSpacing: ".18em",
            textTransform: "uppercase",
            color: RED,
            margin: 0,
          }}
        >
          {t("pillars.eyebrow")}
        </p>
        <h2
          style={{
            fontFamily: SERIF,
            fontWeight: 500,
            fontSize: 24,
            margin: "10px 0 12px",
          }}
        >
          {t("pillars.headline")}
        </h2>
        <p
          style={{
            color: MUTED,
            fontSize: 15,
            lineHeight: 1.6,
            margin: "0 0 26px",
            maxWidth: 520,
          }}
        >
          {t("pillars.body")}
        </p>
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            borderTop: "1px solid rgba(10,10,15,0.1)",
          }}
        >
          {SLM_PILLARS.map(({ pillar, steward }) => (
            <li
              key={pillar}
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 16,
                padding: "13px 0",
                borderBottom: "1px solid rgba(10,10,15,0.1)",
              }}
            >
              <span style={{ fontFamily: SERIF, fontSize: 17, color: INK }}>
                {pillar}
              </span>
              <span style={{ fontSize: 14, color: MUTED, textAlign: "right" }}>
                {steward}
              </span>
            </li>
          ))}
        </ul>

        {/* ── Premium upgrade ──────────────────────────────────────────────── */}
        {(plansLoading || sortedPlans.length > 0) && (
          <div
            id="premium"
            style={{
              marginTop: 56,
              background: "#fff",
              border: highlightUpgrade
                ? `2px solid ${RED}`
                : "1px solid rgba(10,10,15,0.12)",
              borderRadius: 16,
              padding: "28px 26px",
              transition: "border-color .3s",
            }}
          >
            <p
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: ".14em",
                textTransform: "uppercase",
                color: RED,
                margin: 0,
              }}
            >
              {t("premium.badge")}
            </p>
            <h2
              style={{
                fontFamily: SERIF,
                fontWeight: 500,
                fontSize: 26,
                margin: "10px 0 8px",
              }}
            >
              {t("premium.headline")}
            </h2>
            <p
              style={{
                color: MUTED,
                fontSize: 15,
                lineHeight: 1.6,
                margin: "0 0 20px",
              }}
            >
              {t("premium.body")}
            </p>

            {plansLoading ? (
              <p style={{ color: MUTED, fontSize: 14 }}>{t("premium.loading")}</p>
            ) : (
              <form
                onSubmit={handleCheckout}
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  {sortedPlans.map((plan) => {
                    const selected = plan.priceId === selectedPriceId;
                    const isAnnual = plan.plan === "annual";
                    return (
                      <button
                        key={plan.priceId}
                        type="button"
                        onClick={() => setSelectedPriceId(plan.priceId)}
                        style={{
                          textAlign: "left",
                          background: selected ? "#fbf5f5" : "#fff",
                          border: selected
                            ? `2px solid ${RED}`
                            : "1.5px solid rgba(10,10,15,0.14)",
                          borderRadius: 12,
                          padding: "14px 16px",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                        }}
                      >
                        <div>
                          <div
                            style={{
                              fontSize: 15,
                              fontWeight: 700,
                              color: INK,
                            }}
                          >
                            {isAnnual ? t("premium.annual") : t("premium.monthly")}
                            {!isAnnual && (
                              <span
                                style={{
                                  marginLeft: 8,
                                  fontSize: 11,
                                  fontWeight: 700,
                                  color: RED,
                                  background: "#f2dede",
                                  padding: "2px 8px",
                                  borderRadius: 10,
                                }}
                              >
                                {t("premium.mostPopular")}
                              </span>
                            )}
                            {isAnnual && (
                              <span
                                style={{
                                  marginLeft: 8,
                                  fontSize: 11,
                                  fontWeight: 700,
                                  color: RED,
                                  background: "#f2dede",
                                  padding: "2px 8px",
                                  borderRadius: 10,
                                }}
                              >
                                {t("premium.bestValue")}
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 13, color: MUTED }}>
                            {plan.description ?? plan.name ?? t("premium.fullAccess")}
                          </div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div
                            style={{ fontSize: 18, fontWeight: 700, color: INK }}
                          >
                            {formatPrice(plan.unitAmount, plan.currency)}
                          </div>
                          <div style={{ fontSize: 12, color: MUTED }}>
                            /{plan.interval ?? "period"}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
                <input
                  type="email"
                  value={payEmail}
                  onChange={(e) => setPayEmail(e.target.value)}
                  placeholder={t("subscribe.emailPlaceholder")}
                  required
                  style={inputStyle}
                />
                {payError && (
                  <p style={{ color: RED, fontSize: 13, margin: 0 }}>
                    {payError}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={payLoading || !selectedPriceId}
                  style={{
                    background: RED,
                    color: "#fff",
                    border: "none",
                    borderRadius: 10,
                    padding: "14px 18px",
                    fontSize: 16,
                    fontWeight: 600,
                    cursor: payLoading ? "wait" : "pointer",
                    fontFamily: SANS,
                    opacity: payLoading ? 0.7 : 1,
                  }}
                >
                  {payLoading ? t("premium.redirecting") : t("premium.upgradeCta")}
                </button>
              </form>
            )}

            {/* Manage existing subscription */}
            <details style={{ marginTop: 20 }}>
              <summary
                style={{
                  fontSize: 13,
                  color: MUTED,
                  cursor: "pointer",
                  listStyle: "none",
                }}
              >
                {t("premium.manageSummary")}
              </summary>
              <form
                onSubmit={handleManage}
                style={{
                  marginTop: 12,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                <input
                  type="email"
                  value={manageEmail}
                  onChange={(e) => setManageEmail(e.target.value)}
                  placeholder={t("subscribe.emailPlaceholder")}
                  required
                  disabled={manageState === "loading" || manageState === "sent"}
                  style={inputStyle}
                />
                <button
                  type="submit"
                  disabled={manageState === "loading" || manageState === "sent"}
                  style={{
                    background: "#fff",
                    color: RED,
                    border: `1.5px solid rgba(10,10,15,0.14)`,
                    borderRadius: 10,
                    padding: "12px 18px",
                    fontSize: 14,
                    fontWeight: 600,
                    cursor:
                      manageState === "loading" || manageState === "sent"
                        ? "default"
                        : "pointer",
                    fontFamily: SANS,
                  }}
                >
                  {manageState === "loading"
                    ? t("premium.manageSending")
                    : manageState === "sent"
                      ? t("premium.manageSent")
                      : t("premium.manageBtn")}
                </button>
                {manageMsg && (
                  <p
                    style={{
                      fontSize: 13,
                      color: manageState === "error" ? RED : "#2e7d32",
                      margin: 0,
                    }}
                  >
                    {manageMsg}
                  </p>
                )}
              </form>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  border: "1px solid rgba(10,10,15,0.18)",
  borderRadius: 10,
  padding: "14px 16px",
  fontSize: 16,
  fontFamily: SANS,
  background: "#fff",
  color: INK,
  outline: "none",
};
