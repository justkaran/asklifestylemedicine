import { getResendClient } from "./resendClient";
import { logger } from "./logger";
import { sendGuarded } from "./emailGuard";
import { qaInboxAddress } from "./agentMail.js";


const FROM_ADDRESS =
  process.env.NEWSLETTER_FROM ??
  process.env.STORY_FROM ??
  "Palonur · Stanford Lifestyle Medicine <noreply@palonur.com>";

const BASE_URL = (process.env.PUBLIC_URL ?? "https://palonur.replit.app").replace(
  /\/$/,
  "",
);

const RED = "#8B1A1A";
const INK = "#1a0505";

// ── Per-publication branding ─────────────────────────────────────────────────
// Email output is parameterized by publication so a faculty member's own
// newsletter carries their masthead, accent color, footer and from-address,
// while the house (Stanford Lifestyle Medicine) newsletter keeps its original
// look. When no branding is passed the house defaults are used, so existing
// callers (and the SLM routes) render byte-for-byte unchanged.

export type EmailBranding = {
  /** Top eyebrow + the name used in the unsubscribe note. */
  masthead: string;
  /** Bottom footer line. */
  footer: string;
  /** Hex accent color used for the eyebrow, byline, pull-quote rule and CTA. */
  accent: string;
  /** Sender "Name <addr@domain>"; falls back to the shared env default. */
  fromAddress: string;
};

export const HOUSE_BRANDING: EmailBranding = {
  masthead: "Stanford Lifestyle Medicine",
  footer: "Palonur · Stanford Lifestyle Medicine",
  accent: RED,
  fromAddress: FROM_ADDRESS,
};

/**
 * Branding for Karen Parker's Social Brain pillar launch notifications.
 * Used when a subscriber's source is 'karen-parker-pillar' so every email
 * they receive — confirmation and welcome — is clearly attributed to Karen's
 * pillar, not the house SLM newsletter.
 */
export const KAREN_PARKER_BRANDING: EmailBranding = {
  masthead: "Karen Parker · Social Brain",
  footer: "Palonur · Karen Parker",
  accent: RED,
  fromAddress: FROM_ADDRESS,
};

/** Derive email branding from a publication row (house → original SLM look). */
export function brandingForPublication(
  pub:
    | {
        isHouse?: boolean | null;
        name?: string | null;
        accentColor?: string | null;
        fromAddress?: string | null;
      }
    | null
    | undefined,
): EmailBranding {
  if (!pub || pub.isHouse) return HOUSE_BRANDING;
  const name = (pub.name ?? "").trim() || "Palonur";
  const accent =
    pub.accentColor && /^#[0-9a-fA-F]{3,8}$/.test(pub.accentColor.trim())
      ? pub.accentColor.trim()
      : RED;
  return {
    masthead: name,
    footer: `Palonur · ${name}`,
    accent,
    fromAddress: (pub.fromAddress ?? "").trim() || FROM_ADDRESS,
  };
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type IssueForEmail = {
  id: number;
  title: string;
  subjectLine: string | null;
  previewText: string | null;
  introHtml: string | null;
  heroImagePath: string | null;
};

export type PostForEmail = {
  id: number;
  kind: "article" | "story";
  title: string | null;
  authorName: string | null;
  authorInstitution: string | null;
  bodyHtml: string | null;
  pullQuote: string | null;
  imagePath: string | null;
};

function imageUrl(objectPath: string | null): string | null {
  if (!objectPath) return null;
  if (/^https?:\/\//i.test(objectPath)) return objectPath;
  // object-storage paths look like /objects/<id>; served via the api
  if (objectPath.startsWith("/objects/")) {
    return `${BASE_URL}/api/storage${objectPath}`;
  }
  return null;
}

export function buildIssueHtml(args: {
  issue: IssueForEmail;
  posts: PostForEmail[];
  unsubscribeUrl?: string | null;
  branding?: EmailBranding;
  /** When set, append an "Ask <name> a question" CTA linking back to the
   * publication page's Ask panel. Only passed when the publication's steward
   * is ask-eligible (published voice + approved pillar content). */
  askCta?: { url: string; name: string } | null;
  /** When true, append a small "just reply to ask a question" line above the
   * footer. Set by callers when the AgentMail reply inbox is configured (so the
   * newsletter's Reply-To points at it). */
  replyToAsk?: boolean;
}): string {
  const { issue, posts, unsubscribeUrl, askCta, replyToAsk } = args;
  const branding = args.branding ?? HOUSE_BRANDING;
  const RED = branding.accent;
  const hero = imageUrl(issue.heroImagePath);
  const heroBlock = hero
    ? `<img src="${esc(hero)}" alt="" style="width:100%;max-width:600px;border-radius:10px;margin:0 0 22px;" />`
    : "";
  const intro = issue.introHtml
    ? `<div style="font-size:16px;line-height:1.7;color:${INK};margin:0 0 26px;">${issue.introHtml}</div>`
    : "";

  const postsHtml = posts
    .map((p) => {
      const img = imageUrl(p.imagePath);
      const imgBlock = img
        ? `<img src="${esc(img)}" alt="" style="width:100%;max-width:600px;border-radius:10px;margin:0 0 14px;" />`
        : "";
      const eyebrow =
        p.kind === "story"
          ? `<p style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:${RED};margin:0 0 6px;">A reader's story</p>`
          : p.authorName
            ? `<p style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:${RED};margin:0 0 6px;">By ${esc(p.authorName)}${p.authorInstitution ? ` · ${esc(p.authorInstitution)}` : ""}</p>`
            : "";
      const title = p.title
        ? `<h2 style="font-family:Georgia,serif;font-weight:500;font-size:24px;line-height:1.25;margin:0 0 10px;color:${INK};">${esc(p.title)}</h2>`
        : "";
      const body = p.bodyHtml
        ? `<div style="font-size:16px;line-height:1.7;color:${INK};">${p.bodyHtml}</div>`
        : "";
      const pull = p.pullQuote
        ? `<blockquote style="font-family:Georgia,serif;font-style:italic;font-size:19px;line-height:1.45;border-left:3px solid ${RED};padding:6px 18px;margin:16px 0;color:${INK};">${esc(p.pullQuote)}</blockquote>`
        : "";
      return `<section style="margin:0 0 40px;">${imgBlock}${eyebrow}${title}${pull}${body}</section>`;
    })
    .join("\n");

  const askBlock = askCta
    ? `<div style="background:#FBF7F0;border:1px solid #e7e0d8;border-radius:12px;padding:22px;text-align:center;margin:8px 0 30px;">
    <p style="font-family:Georgia,serif;font-size:20px;line-height:1.4;margin:0 0 6px;color:${INK};">Have a question for ${esc(askCta.name)}?</p>
    <p style="font-size:15px;line-height:1.6;color:#5a3030;margin:0 0 16px;">Ask and get an answer in their own words, grounded in their published research.</p>
    <a href="${esc(askCta.url)}" style="background:${RED};color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;font-weight:600;">Ask ${esc(askCta.name)} a question</a>
  </div>`
    : "";

  const replyAsk = replyToAsk
    ? `<p style="font-size:14px;line-height:1.6;color:#5a3030;margin:0 0 4px;"><strong>Have a question?</strong> Just reply to this email. One of our Stanford experts will answer in their own words, grounded in their published research.</p>`
    : "";

  const unsub = unsubscribeUrl
    ? `<p style="font-size:12px;color:#888;margin-top:8px;">You're receiving this because you subscribed to the ${esc(branding.masthead)} newsletter. <a href="${esc(unsubscribeUrl)}" style="color:#888;">Unsubscribe</a>.</p>`
    : "";

  const preview = issue.previewText
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(issue.previewText)}</div>`
    : "";

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#FAF8F4;padding:0;">
${preview}
<div style="max-width:600px;margin:0 auto;padding:32px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <p style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:${RED};margin:0 0 6px;">${esc(branding.masthead)}</p>
  <h1 style="font-family:Georgia,serif;font-weight:500;font-size:30px;line-height:1.2;margin:0 0 22px;color:${INK};">${esc(issue.title)}</h1>
  ${heroBlock}
  ${intro}
  ${postsHtml}
  ${askBlock}
  <hr style="border:none;border-top:1px solid #e7e0d8;margin:30px 0 14px;" />
  ${replyAsk}
  <p style="font-size:12px;color:#888;margin:0 0 6px;">Your newsletters and the ask-an-expert Q&amp;A, all in one place — <a href="${esc(membersSignInUrl())}" style="color:${RED};">open your reading room</a>.</p>
  <p style="font-size:12px;color:#888;margin:0;">${esc(branding.footer)}</p>
  ${unsub}
</div>
</body></html>`;
}

/**
 * Teaser version of an issue for FREE subscribers when the issue is premium.
 * Shows the title, intro, and the first post's title + a short excerpt, then a
 * prominent upgrade call-to-action linking back to the newsletter page.
 */
export function buildTeaserHtml(args: {
  issue: IssueForEmail;
  posts: PostForEmail[];
  unsubscribeUrl?: string | null;
  upgradeUrl: string;
  branding?: EmailBranding;
}): string {
  const { issue, posts, unsubscribeUrl, upgradeUrl } = args;
  const branding = args.branding ?? HOUSE_BRANDING;
  const RED = branding.accent;
  const hero = imageUrl(issue.heroImagePath);
  const heroBlock = hero
    ? `<img src="${esc(hero)}" alt="" style="width:100%;max-width:600px;border-radius:10px;margin:0 0 22px;" />`
    : "";
  const intro = issue.introHtml
    ? `<div style="font-size:16px;line-height:1.7;color:${INK};margin:0 0 26px;">${issue.introHtml}</div>`
    : "";

  const first = posts[0];
  let teaserBlock = "";
  if (first) {
    const title = first.title
      ? `<h2 style="font-family:Georgia,serif;font-weight:500;font-size:24px;line-height:1.25;margin:0 0 10px;color:${INK};">${esc(first.title)}</h2>`
      : "";
    const excerptText = first.bodyHtml ? htmlToText(first.bodyHtml) : "";
    const excerpt = excerptText
      ? `<p style="font-size:16px;line-height:1.7;color:${INK};margin:0 0 6px;">${esc(excerptText.slice(0, 280))}${excerptText.length > 280 ? "…" : ""}</p>`
      : "";
    teaserBlock = `<section style="margin:0 0 26px;">${title}${excerpt}</section>`;
  }

  const cta = `<div style="background:#FCEFEF;border:1px solid #f0d6d6;border-radius:12px;padding:22px;text-align:center;margin:8px 0 30px;">
    <p style="font-family:Georgia,serif;font-size:20px;line-height:1.4;margin:0 0 6px;color:${INK};">This is a premium issue.</p>
    <p style="font-size:15px;line-height:1.6;color:#5a3030;margin:0 0 16px;">Upgrade to read the full edition and every premium issue going forward.</p>
    <a href="${esc(upgradeUrl)}" style="background:${RED};color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;font-weight:600;">Upgrade to premium</a>
  </div>`;

  const unsub = unsubscribeUrl
    ? `<p style="font-size:12px;color:#888;margin-top:8px;">You're receiving this because you subscribed to the ${esc(branding.masthead)} newsletter. <a href="${esc(unsubscribeUrl)}" style="color:#888;">Unsubscribe</a>.</p>`
    : "";

  const preview = issue.previewText
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(issue.previewText)}</div>`
    : "";

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#FAF8F4;padding:0;">
${preview}
<div style="max-width:600px;margin:0 auto;padding:32px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <p style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:${RED};margin:0 0 6px;">${esc(branding.masthead)} · Premium</p>
  <h1 style="font-family:Georgia,serif;font-weight:500;font-size:30px;line-height:1.2;margin:0 0 22px;color:${INK};">${esc(issue.title)}</h1>
  ${heroBlock}
  ${intro}
  ${teaserBlock}
  ${cta}
  <hr style="border:none;border-top:1px solid #e7e0d8;margin:30px 0 14px;" />
  <p style="font-size:12px;color:#888;margin:0 0 6px;">Your newsletters and the ask-an-expert Q&amp;A, all in one place — <a href="${esc(membersSignInUrl())}" style="color:${RED};">open your reading room</a>.</p>
  <p style="font-size:12px;color:#888;margin:0;">${esc(branding.footer)}</p>
  ${unsub}
</div>
</body></html>`;
}

/**
 * Build (but do not send) the one-time branded welcome email. Returns the
 * rendered `subject`, `html` and plain-text `text`, parameterized by publication
 * `branding` and the steward's name:
 *   • House (no branding passed, or HOUSE_BRANDING) renders byte-for-byte
 *     unchanged from the original SLM copy.
 *   • A faculty publication carries that newsletter's masthead, accent color,
 *     footer and from-address, names the steward, and notes it's free.
 * States the cadence ("a few times a month") and that it's free. `sendWelcomeEmail`
 * and the steward-facing welcome-email preview/test-send both call this, so a
 * preview a steward sees can never drift from what subscribers actually receive.
 */
export function buildWelcomeEmail(args: {
  name?: string | null;
  unsubscribeUrl?: string | null;
  branding?: EmailBranding;
  /** The faculty steward's name (publication byline). Ignored for the house. */
  stewardName?: string | null;
}): { subject: string; html: string; text: string } {
  const branding = args.branding ?? HOUSE_BRANDING;
  const isHouse = branding === HOUSE_BRANDING;
  const accent = branding.accent;
  const masthead = branding.masthead;
  const footer = branding.footer;
  const steward = args.stewardName?.trim() || null;

  const greeting = args.name?.trim()
    ? `Welcome, ${esc(args.name.trim())}.`
    : "Welcome.";
  const greetingText = args.name?.trim()
    ? `Welcome, ${args.name.trim()}.`
    : "Welcome.";

  // House keeps its original copy byte-for-byte; faculty publications get a
  // version that names the steward and still makes clear it's free.
  const introHtml = isHouse
    ? `<p style="margin:0 0 16px;">Thanks for subscribing. A few times a month, we'll send you one evidence-based thing to try, the research behind it, and real anonymized stories from our community — signed by name, never spam.</p>
    <p style="margin:0 0 16px;">It's free, and you can unsubscribe anytime.</p>`
    : `<p style="margin:0 0 16px;">Thanks for subscribing to ${esc(masthead)}.${steward ? ` A few times a month, ${esc(steward)} will send you one evidence-based idea, grounded in their own research — signed by name, never spam.` : ` A few times a month, you'll get one evidence-based idea, grounded in published research — signed by name, never spam.`}</p>
    <p style="margin:0 0 16px;">It's free, and you can unsubscribe anytime.</p>`;

  const introText = isHouse
    ? `Thanks for subscribing to the ${masthead} newsletter. A few times a month, we'll send you one evidence-based thing to try, the research behind it, and real anonymized stories from our community — signed by name, never spam.

It's free, and you can unsubscribe anytime.`
    : `Thanks for subscribing to ${masthead}.${steward ? ` A few times a month, ${steward} will send you one evidence-based idea, grounded in their own research — signed by name, never spam.` : ` A few times a month, you'll get one evidence-based idea, grounded in published research — signed by name, never spam.`}

It's free, and you can unsubscribe anytime.`;

  const unsub = args.unsubscribeUrl
    ? `<p style="font-size:12px;color:#888;margin-top:8px;">You're receiving this because you subscribed to the ${esc(masthead)} newsletter. <a href="${esc(args.unsubscribeUrl)}" style="color:#888;">Unsubscribe</a>.</p>`
    : "";

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#FAF8F4;padding:0;">
<div style="max-width:600px;margin:0 auto;padding:32px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <p style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:${accent};margin:0 0 6px;">${esc(masthead)}</p>
  <h1 style="font-family:Georgia,serif;font-weight:500;font-size:30px;line-height:1.2;margin:0 0 22px;color:${INK};">${greeting}</h1>
  <div style="font-size:16px;line-height:1.7;color:${INK};">
    ${introHtml}
  </div>
  <hr style="border:none;border-top:1px solid #e7e0d8;margin:30px 0 14px;" />
  <p style="font-size:12px;color:#888;margin:0;">${esc(footer)}</p>
  ${unsub}
</div>
</body></html>`;

  const text = `${greetingText}

${introText}${args.unsubscribeUrl ? `\n\nUnsubscribe: ${args.unsubscribeUrl}` : ""}

— ${footer}`;

  return { subject: `Welcome to ${masthead}`, html, text };
}

export async function sendWelcomeEmail(args: {
  to: string;
  name?: string | null;
  unsubscribeUrl?: string | null;
  branding?: EmailBranding;
  /** The faculty steward's name (publication byline). Ignored for the house. */
  stewardName?: string | null;
}): Promise<boolean> {
  const branding = args.branding ?? HOUSE_BRANDING;
  const { subject, html, text } = buildWelcomeEmail(args);

  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to },
      "Resend not configured — would send newsletter welcome email",
    );
    return false;
  }
  const { error } = await sendGuarded(
    conn.client,
    {
      from: branding.fromAddress,
      to: args.to,
      subject,
      html,
      text,
    },
    { label: "newsletter welcome" },
  );
  if (error) {
    logger.error({ err: error, to: args.to }, "Failed to send welcome email");
    return false;
  }
  return true;
}

/** Send the secure "manage your subscription" portal link to a paid subscriber. */
export async function sendNewsletterPortalLink(args: {
  to: string;
  url: string;
}): Promise<void> {
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${INK};max-width:540px;margin:0 auto;padding:24px;">
  <p>Manage or cancel your Palonur premium newsletter subscription:</p>
  <p style="margin:28px 0;"><a href="${esc(args.url)}" style="background:${RED};color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;">Manage subscription</a></p>
  <p style="color:#666;font-size:13px;">This link expires in 30 minutes. If you didn't request it, you can ignore this email.</p>
  <p style="color:#999;font-size:12px;margin-top:32px;">— Palonur · Stanford Lifestyle Medicine</p>
  </body></html>`;
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to, url: args.url },
      "Resend not configured — would send newsletter portal link",
    );
    return;
  }
  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to: args.to,
      subject: "Manage your Palonur newsletter subscription",
      text: `Manage your subscription: ${args.url}\n\nExpires in 30 minutes.`,
      html,
    },
    { label: "newsletter portal link" },
  );
  if (error) {
    logger.error({ err: error, to: args.to }, "Failed to send newsletter portal link");
  }
}

/**
 * Send a one-time passwordless sign-in link for the consumer members area. The
 * link opens `/members-login?token=…`, which exchanges the token for an
 * isolated `members_session` cookie. Mirrors the other magic-link senders:
 * degrades to a warn (never throws) when Resend is unconfigured, and the
 * calling route always returns a generic success so it never leaks whether the
 * email belongs to a real subscriber.
 */
export async function sendSubscriberSignInLink(args: {
  to: string;
  name?: string | null;
  token: string;
}): Promise<void> {
  const link = `${BASE_URL}/members-login?token=${encodeURIComponent(args.token)}`;
  const greeting = args.name ? `Hi ${esc(args.name)},` : "Hello,";
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${INK};max-width:540px;margin:0 auto;padding:24px;">
  <p>${greeting}</p>
  <p>Here is your one-time link to your Palonur reading room — your newsletters and the ask-an-expert Q&amp;A, all in one place:</p>
  <p style="margin:28px 0;"><a href="${esc(link)}" style="background:${RED};color:#fff;text-decoration:none;padding:13px 22px;border-radius:999px;display:inline-block;font-weight:600;">Open my reading room</a></p>
  <p style="color:#666;font-size:13px;">This link expires in 30 minutes and is just for you. If you didn't request it, you can ignore this email.</p>
  <p style="color:#999;font-size:12px;margin-top:32px;">— Palonur · Stanford Lifestyle Medicine</p>
  </body></html>`;
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to, link },
      "Resend not configured — would send members sign-in link",
    );
    return;
  }
  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to: args.to,
      subject: "Your Palonur reading-room sign-in link",
      text: `${args.name ? `Hi ${args.name},` : "Hello,"}\n\nOpen your Palonur reading room: ${link}\n\nExpires in 30 minutes. If you didn't request it, ignore this email.`,
      html,
    },
    { label: "members sign-in link" },
  );
  if (error) {
    logger.error(
      { err: error, to: args.to },
      "Failed to send members sign-in link",
    );
  }
}

/**
 * Send the double opt-in confirmation email to a brand-new subscriber. They are
 * created in the `pending` state and receive NO newsletters until they click the
 * link in this email (which flips them to `active`). Branded per publication.
 * Returns true on success; warns and returns false when Resend is not
 * configured, so callers can surface a graceful "check your email" either way.
 */
export async function sendSubscriberConfirmationEmail(args: {
  to: string;
  name?: string | null;
  confirmUrl: string;
  branding?: EmailBranding;
}): Promise<boolean> {
  const branding = args.branding ?? HOUSE_BRANDING;
  const greeting = args.name ? `Hi ${esc(args.name.trim())},` : "Hi there,";
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${INK};max-width:540px;margin:0 auto;padding:24px;">
  <p style="text-transform:uppercase;letter-spacing:0.08em;font-size:12px;color:${esc(branding.accent)};font-weight:600;margin:0 0 16px;">${esc(branding.masthead)}</p>
  <p style="margin:0 0 12px;">${greeting}</p>
  <p style="margin:0 0 12px;">Please confirm you'd like to receive the ${esc(branding.masthead)} newsletter. We won't send you anything until you do.</p>
  <p style="margin:28px 0;"><a href="${esc(args.confirmUrl)}" style="background:${esc(branding.accent)};color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;font-weight:600;">Confirm my subscription</a></p>
  <p style="color:#666;font-size:13px;margin:0 0 8px;">Or paste this link into your browser:<br><span style="color:#888;word-break:break-all;">${esc(args.confirmUrl)}</span></p>
  <p style="color:#666;font-size:13px;margin:16px 0 0;">If you didn't request this, you can safely ignore this email — you won't receive anything unless you confirm.</p>
  <p style="color:#999;font-size:12px;margin-top:32px;">— ${esc(branding.footer)}</p>
  </body></html>`;
  const text = `${args.name ? `Hi ${args.name.trim()},` : "Hi there,"}

Please confirm you'd like to receive the ${branding.masthead} newsletter. We won't send you anything until you do.

Confirm your subscription: ${args.confirmUrl}

If you didn't request this, you can safely ignore this email — you won't receive anything unless you confirm.

— ${branding.footer}`;
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to, confirmUrl: args.confirmUrl },
      "Resend not configured — would send subscriber confirmation email",
    );
    return false;
  }
  const { error } = await sendGuarded(
    conn.client,
    {
      from: branding.fromAddress,
      to: args.to,
      subject: `Confirm your subscription to ${branding.masthead}`,
      html,
      text,
    },
    { label: "subscriber confirmation" },
  );
  if (error) {
    logger.error(
      { err: error, to: args.to },
      "Failed to send subscriber confirmation email",
    );
    return false;
  }
  return true;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|h1|h2|h3|section|blockquote|div)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function unsubscribeUrlFor(token: string): string {
  return `${BASE_URL}/api/newsletter/unsubscribe?token=${encodeURIComponent(token)}`;
}

/** Absolute double opt-in confirmation link emailed to a new subscriber. */
export function confirmUrlFor(token: string): string {
  return `${BASE_URL}/api/newsletter/confirm?token=${encodeURIComponent(token)}`;
}

/** Absolute link to the consumer reading-room sign-in page. Email clients can't
 * resolve relative URLs, so sent newsletters link here so recipients can open
 * their reading room (newsletters + ask-an-expert Q&A) with a magic link. */
export function membersSignInUrl(): string {
  return `${BASE_URL}/members-login`;
}

/** Absolute link to a publication page's Ask panel (the `#ask` anchor). Used by
 * the email "Ask <steward> a question" CTA — email clients can't resolve
 * relative URLs. */
export function publicationAskUrl(slug: string): string {
  return `${BASE_URL}/p/${encodeURIComponent(slug)}#ask`;
}

/**
 * Send a single rendered email. Returns true on success.
 */
export async function sendNewsletterEmail(args: {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
  /** Override the Reply-To. Defaults to the AgentMail Q&A inbox when one is
   * configured, so a reader can reply to the newsletter to ask a question and
   * get an AI answer back. Pass `null` to explicitly suppress it. */
  replyTo?: string | null;
  /** Label recorded in the email_sends audit (defaults to "newsletter issue"). */
  label?: string;
}): Promise<boolean> {
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to, subject: args.subject },
      "Resend not configured — would send newsletter email",
    );
    return false;
  }
  const replyTo =
    args.replyTo === null
      ? undefined
      : (args.replyTo?.trim() || qaInboxAddress() || undefined);
  const { error } = await sendGuarded(
    conn.client,
    {
      from: args.from?.trim() || FROM_ADDRESS,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      ...(replyTo ? { replyTo } : {}),
    },
    { label: args.label ?? "newsletter issue" },
  );
  if (error) {
    logger.error({ err: error, to: args.to }, "Failed to send newsletter email");
    return false;
  }
  return true;
}

export async function newsletterResendConfigured(): Promise<boolean> {
  return Boolean(await getResendClient());
}

// ── Email Q&A reply ──────────────────────────────────────────────────────────

/** The parsed result shape from `answerNewsletterQuestion`, kept structural so
 * this formatter has no import cycle with the Q&A engine. */
export type QaReplyInput = {
  outcome: "answered" | "uncovered" | "unavailable";
  expert: { name: string | null; pillarName: string } | null;
  answer: string | null;
  interpretation: string | null;
  action: string | null;
  citation: string | null;
  paper: string | null;
};

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) =>
        `<p style="font-size:16px;line-height:1.7;color:${INK};margin:0 0 16px;">${esc(
          p,
        ).replace(/\n/g, "<br/>")}</p>`,
    )
    .join("\n");
}

/**
 * Render the answer email sent back to a reader who replied to the newsletter.
 *
 * On the `answered` path it names the routed Stanford expert + pillar, renders
 * the answer (plus an optional "What this means" / "Try this" block), and shows
 * the source citation. On `uncovered` / `unavailable` it returns an honest
 * fallback that does NOT fabricate an answer and points back to the site. Pure
 * function (returns subject/html/text); the route sends it via the guarded
 * Resend path with Reply-To set to the inbox so the reader can ask again.
 */
export function buildQaReplyEmail(input: {
  question: string;
  result: QaReplyInput;
  /** Original inbound subject, used to build a "Re: ..." subject. */
  subject?: string | null;
}): { subject: string; html: string; text: string } {
  const branding = HOUSE_BRANDING;
  const { result } = input;
  const cleanSubject = (input.subject ?? "").replace(/^\s*(re:\s*)+/i, "").trim();
  const reSubject = cleanSubject
    ? `Re: ${cleanSubject}`
    : "Your question, answered";

  const header = `<p style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:${branding.accent};margin:0 0 6px;">${esc(
    branding.masthead,
  )}</p>`;
  const footer = `<hr style="border:none;border-top:1px solid #e7e0d8;margin:30px 0 14px;" />
  <p style="font-size:12px;color:#888;margin:0;">${esc(branding.footer)}. General educational information, not medical advice.</p>`;

  if (result.outcome === "answered") {
    const expertName = result.expert?.name?.trim();
    const pillarName = result.expert?.pillarName?.trim();
    const byline = expertName
      ? `Answered by ${expertName}${pillarName ? ` · ${pillarName}` : ""}`
      : pillarName
        ? `Answered from our ${pillarName} research`
        : "Answered from our research";

    const answerHtml = result.answer ? paragraphs(result.answer) : "";
    const meansHtml = result.interpretation
      ? `<p style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:${branding.accent};margin:18px 0 6px;">What this means</p>${paragraphs(
          result.interpretation,
        )}`
      : "";
    const actionHtml = result.action
      ? `<p style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:${branding.accent};margin:18px 0 6px;">Try this</p>${paragraphs(
          result.action,
        )}`
      : "";
    const sourceLine = [result.citation, result.paper]
      .map((s) => (s ?? "").trim())
      .filter(Boolean)
      .join(" — ");
    const sourceHtml = sourceLine
      ? `<p style="font-size:13px;line-height:1.6;color:#7a5a5a;margin:20px 0 0;"><strong>Source:</strong> ${esc(
          sourceLine,
        )}</p>`
      : "";

    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#FAF8F4;padding:0;">
<div style="max-width:600px;margin:0 auto;padding:32px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  ${header}
  <p style="font-size:13px;color:#7a5a5a;margin:0 0 4px;">You asked:</p>
  <p style="font-family:Georgia,serif;font-style:italic;font-size:18px;line-height:1.45;color:${INK};margin:0 0 18px;">${esc(
    input.question,
  )}</p>
  <p style="font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:${branding.accent};margin:0 0 14px;">${esc(
    byline,
  )}</p>
  ${answerHtml}
  ${meansHtml}
  ${actionHtml}
  ${sourceHtml}
  <p style="font-size:14px;line-height:1.6;color:#5a3030;margin:22px 0 0;">Have another question? Just reply to this email.</p>
  ${footer}
</div>
</body></html>`;

    const textParts = [
      `You asked: ${input.question}`,
      "",
      byline,
      "",
      result.answer ?? "",
      result.interpretation ? `\nWhat this means:\n${result.interpretation}` : "",
      result.action ? `\nTry this:\n${result.action}` : "",
      sourceLine ? `\nSource: ${sourceLine}` : "",
      "\nHave another question? Just reply to this email.",
      `\n— ${branding.footer}`,
    ].filter((s) => s !== "");
    return { subject: reSubject, html, text: textParts.join("\n") };
  }

  // uncovered / unavailable → honest fallback, no fabricated answer.
  const fallbackLead =
    result.outcome === "unavailable"
      ? "Thanks for your question. We don't have published material from our Stanford experts that covers this yet, so we'd rather not guess."
      : "Thanks for your question. None of our Stanford experts have published material that covers this one yet, so we'd rather not guess than give you an answer we can't stand behind.";
  const browseUrl = `${BASE_URL}/`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#FAF8F4;padding:0;">
<div style="max-width:600px;margin:0 auto;padding:32px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  ${header}
  <p style="font-size:13px;color:#7a5a5a;margin:0 0 4px;">You asked:</p>
  <p style="font-family:Georgia,serif;font-style:italic;font-size:18px;line-height:1.45;color:${INK};margin:0 0 18px;">${esc(
    input.question,
  )}</p>
  <p style="font-size:16px;line-height:1.7;color:${INK};margin:0 0 16px;">${esc(
    fallbackLead,
  )}</p>
  <p style="font-size:16px;line-height:1.7;color:${INK};margin:0 0 16px;">You can explore what our experts have published at <a href="${esc(
    browseUrl,
  )}" style="color:${branding.accent};">palonur.com</a>, or reply with a different question.</p>
  ${footer}
</div>
</body></html>`;
  const text = [
    `You asked: ${input.question}`,
    "",
    fallbackLead,
    "",
    `You can explore what our experts have published at ${browseUrl}, or reply with a different question.`,
    `\n— ${branding.footer}`,
  ].join("\n");
  return { subject: reSubject, html, text };
}

// ── Karen Parker pillar-launch notification emails ────────────────────────────
// These are NOT newsletter subscription emails. A visitor who fills in the
// Karen Parker early-access form on the home page is subscribing to a launch
// notification list, not the SLM house newsletter. Every email they receive
// must be clearly attributed to "Karen Parker · Social Brain" and framed as
// "we will notify you when the pillar opens" — not "thanks for subscribing."

/**
 * Double opt-in confirmation for Karen Parker pillar launch notification.
 * Framed as early-access interest, not newsletter subscription.
 */
export async function sendKarenPillarNotificationConfirmation(args: {
  to: string;
  name?: string | null;
  confirmUrl: string;
}): Promise<boolean> {
  const accent = RED;
  const masthead = "Karen Parker · Social Brain";
  const footer = "Palonur · Karen Parker";
  const greeting = args.name ? `Hi ${esc(args.name.trim())},` : "Hi there,";
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${INK};max-width:540px;margin:0 auto;padding:24px;">
  <p style="text-transform:uppercase;letter-spacing:0.08em;font-size:12px;color:${accent};font-weight:600;margin:0 0 16px;">${esc(masthead)}</p>
  <p style="margin:0 0 12px;">${greeting}</p>
  <p style="margin:0 0 12px;">Please confirm your interest in being notified when Karen Parker's Social Brain pillar opens on Palonur. We will not contact you for any other reason until you confirm.</p>
  <p style="margin:28px 0;"><a href="${esc(args.confirmUrl)}" style="background:${accent};color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;font-weight:600;">Confirm my interest</a></p>
  <p style="color:#666;font-size:13px;margin:0 0 8px;">Or paste this link into your browser:<br><span style="color:#888;word-break:break-all;">${esc(args.confirmUrl)}</span></p>
  <p style="color:#666;font-size:13px;margin:16px 0 0;">If you did not request this, you can safely ignore this email.</p>
  <p style="color:#999;font-size:12px;margin-top:32px;">— ${esc(footer)}</p>
  </body></html>`;
  const text = `${args.name ? `Hi ${args.name.trim()},` : "Hi there,"}

Please confirm your interest in being notified when Karen Parker's Social Brain pillar opens on Palonur. We will not contact you for any other reason until you confirm.

Confirm your interest: ${args.confirmUrl}

If you did not request this, you can safely ignore this email.

— ${footer}`;
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to, confirmUrl: args.confirmUrl },
      "Resend not configured — would send Karen pillar notification confirmation",
    );
    return false;
  }
  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to: args.to,
      subject: "Confirm your interest: Karen Parker's Social Brain pillar",
      html,
      text,
    },
    { label: "karen pillar notification confirm" },
  );
  if (error) {
    logger.error(
      { err: error, to: args.to },
      "Failed to send Karen pillar notification confirmation",
    );
    return false;
  }
  return true;
}

/**
 * One-time welcome sent after a Karen Parker pillar notification subscriber
 * confirms their interest. Framed as early-access list registration, not a
 * newsletter welcome.
 */
export async function sendKarenPillarWelcomeEmail(args: {
  to: string;
  name?: string | null;
  unsubscribeUrl?: string | null;
}): Promise<boolean> {
  const accent = RED;
  const masthead = "Karen Parker · Social Brain";
  const footer = "Palonur · Karen Parker";
  const greeting = args.name?.trim()
    ? `Welcome, ${esc(args.name.trim())}.`
    : "Welcome.";
  const unsub = args.unsubscribeUrl
    ? `<p style="font-size:12px;color:#888;margin-top:8px;">You are on this list because you requested early access. <a href="${esc(args.unsubscribeUrl)}" style="color:#888;">Remove me from this list</a>.</p>`
    : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#FAF8F4;padding:0;">
<div style="max-width:600px;margin:0 auto;padding:32px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <p style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:${accent};margin:0 0 6px;">${esc(masthead)}</p>
  <h1 style="font-family:Georgia,serif;font-weight:500;font-size:30px;line-height:1.2;margin:0 0 22px;color:${INK};">${greeting}</h1>
  <div style="font-size:16px;line-height:1.7;color:${INK};">
    <p style="margin:0 0 16px;">You are on Karen Parker's early-access list. The moment her Social Brain pillar opens on Palonur, you will be the first to know.</p>
    <p style="margin:0 0 16px;">Dr. Parker is a professor of psychiatry and behavioral sciences at Stanford. Her pillar covers the neuroscience of human connection, including autism spectrum research and how social engagement shapes brain health across the lifespan.</p>
  </div>
  <hr style="border:none;border-top:1px solid #e7e0d8;margin:30px 0 14px;" />
  <p style="font-size:12px;color:#888;margin:0;">${esc(footer)}</p>
  ${unsub}
</div>
</body></html>`;
  const text = `${args.name?.trim() ? `Welcome, ${args.name.trim()}.` : "Welcome."}

You are on Karen Parker's early-access list. The moment her Social Brain pillar opens on Palonur, you will be the first to know.

Dr. Parker is a professor of psychiatry and behavioral sciences at Stanford. Her pillar covers the neuroscience of human connection, including autism spectrum research and how social engagement shapes brain health across the lifespan.${args.unsubscribeUrl ? `\n\nRemove me from this list: ${args.unsubscribeUrl}` : ""}

— ${footer}`;
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to },
      "Resend not configured — would send Karen pillar welcome email",
    );
    return false;
  }
  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to: args.to,
      subject: "You are on Karen Parker's early-access list",
      html,
      text,
    },
    { label: "karen pillar welcome" },
  );
  if (error) {
    logger.error(
      { err: error, to: args.to },
      "Failed to send Karen pillar welcome email",
    );
    return false;
  }
  return true;
}
