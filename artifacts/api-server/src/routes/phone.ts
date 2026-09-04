import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomBytes, timingSafeEqual } from "crypto";
import { and, eq, desc, inArray } from "drizzle-orm";
import { db, phoneSubscribersTable } from "@workspace/db";
import { SubscribePhoneBody } from "@workspace/api-zod";
import { sendImessage } from "../lib/imessage.js";
import { getConsumerFromRequest } from "../lib/consumerAuth.js";
import { handleDoorwayInbound, doorwayDedupKey } from "../lib/doorway.js";

const router: IRouter = Router();

const BASE_URL = process.env.PUBLIC_URL ?? "https://palonur.replit.app";

function checkAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.signedCookies?.palonur_admin === "1") return next();
  res.status(401).json({ error: "unauthorized" });
}

const PRODUCT_LABELS: Record<"nightly", string> = {
  nightly: "Pal",
};

// Standard opt-out / opt-in keyword families (matched case-insensitively on the
// first word of an inbound reply). STOP-family always wins over START-family.
const STOP_WORDS = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "optout",
  "opt-out",
  "revoke",
]);
const START_WORDS = new Set([
  "yes",
  "y",
  "start",
  "unstop",
  "confirm",
  "subscribe",
]);

/**
 * Inbound provider webhooks mutate consent state, so when a shared secret is
 * configured (`IMESSAGE_WEBHOOK_SECRET`) we require the provider to present it
 * — set the same value on the provider's configured webhook URL (e.g.
 * `?secret=…`) or have it send an `x-webhook-secret` header. Read dynamically
 * so a deployment (or a test) can toggle it without a rebuild. Constant-time
 * compare to avoid leaking the secret via timing.
 */
function webhookAuthentic(req: Request): boolean {
  const secret = process.env.IMESSAGE_WEBHOOK_SECRET;
  if (!secret) return false;
  const provided =
    req.get("x-webhook-secret") ??
    (typeof req.query.secret === "string" ? req.query.secret : "") ??
    "";
  const a = Buffer.from(String(provided));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Normalize a loosely-typed phone number to E.164 (e.g. +14155550123), or null
 * when it can't be coerced to a plausible number. Storing normalized is what
 * makes idempotency + opt-out lookups exact. Defaults a bare 10-digit number to
 * US (+1) since these are US consumer products; an explicit leading + is always
 * honored as-is.
 */
export function normalizeE164(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const hasPlus = s.startsWith("+");
  const digits = s.replace(/\D/g, "");
  if (hasPlus) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

function buildOptInMessage(product: "nightly", token: string): string {
  const label = PRODUCT_LABELS[product];
  const confirmUrl = `${BASE_URL}/api/phone/confirm?token=${token}`;
  return (
    `${label} (Palonur): you asked to get texts from us. ` +
    `Reply YES to confirm, or tap ${confirmUrl}. Reply STOP to opt out. ` +
    `Once you're in, you can reply to this thread any time — especially at 3am.`
  );
}

// ── Public: capture a phone opt-in (contract: POST /phone/subscribe) ──────────
router.post("/phone/subscribe", async (req: Request, res: Response) => {
  const parsed = SubscribePhoneBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }
  const { phone, product, consent, source } = parsed.data;

  // Consent is mandatory and must be an explicit, affirmative opt-in.
  if (consent !== true) {
    return res.status(400).json({ error: "Consent is required" });
  }
  const normalized = normalizeE164(phone);
  if (!normalized) {
    return res.status(400).json({ error: "A valid phone number is required" });
  }
  const sourceClean = source ? String(source).trim().slice(0, 80) : "web";

  // If the visitor is a signed-in consumer, link the number to their account so
  // it stops being anonymous capture. Logged-out visitors stay fully supported
  // (consumerAccountId remains null). Never fail the opt-in if this lookup
  // hiccups — capture must always succeed.
  let consumerAccountId: number | null = null;
  try {
    const account = await getConsumerFromRequest(req);
    if (account) consumerAccountId = account.id;
  } catch (err) {
    req.log.warn({ err }, "phone subscribe: consumer lookup failed (ignored)");
  }

  try {
    const existing = await db
      .select()
      .from(phoneSubscribersTable)
      .where(
        and(
          eq(phoneSubscribersTable.product, product),
          eq(phoneSubscribersTable.phone, normalized),
        ),
      )
      .limit(1);

    if (existing[0]) {
      // Backfill the account link if a now-signed-in consumer re-submits a
      // number that was first captured anonymously (never un-links it).
      if (consumerAccountId && existing[0].consumerAccountId == null) {
        await db
          .update(phoneSubscribersTable)
          .set({ consumerAccountId })
          .where(eq(phoneSubscribersTable.id, existing[0].id));
      }
      // Already confirmed/active — nothing to do, no re-send.
      if (existing[0].status === "active") {
        return res.json({ ok: true, alreadySubscribed: true });
      }
      // Still pending — a confirmation text was already sent and we're waiting
      // on them. Re-submitting (a double-tap, a refresh, a second visit) is an
      // idempotent no-op: we do NOT mint a new token or send another (paid)
      // text, so the same number can never be re-spammed by repeat submits.
      if (existing[0].status === "pending") {
        return res.json({ ok: true, pending: true });
      }
      // Previously opted out and now explicitly opting back in via the consent
      // form — a genuine new consent cycle. Re-issue a fresh confirmation and
      // record the renewed consent (returns the row to pending until confirmed,
      // no duplicate row).
      const confirmToken = randomBytes(24).toString("hex");
      await db
        .update(phoneSubscribersTable)
        .set({
          status: "pending",
          source: sourceClean,
          consentAt: new Date(),
          confirmToken,
          confirmedAt: null,
          optedOutAt: null,
          // Only adopt the link when the row is unowned — never reassign a row
          // already owned by another account (matches the backfill guard above).
          ...(consumerAccountId && existing[0].consumerAccountId == null
            ? { consumerAccountId }
            : {}),
        })
        .where(eq(phoneSubscribersTable.id, existing[0].id));
      await sendImessage({
        to: normalized,
        body: buildOptInMessage(product, confirmToken),
        label: "phone opt-in confirmation",
      });
      return res.json({ ok: true, pending: true });
    }

    // Brand-new opt-in: create as pending and send one confirmation text.
    const confirmToken = randomBytes(24).toString("hex");
    await db.insert(phoneSubscribersTable).values({
      phone: normalized,
      product,
      status: "pending",
      source: sourceClean,
      consentAt: new Date(),
      confirmToken,
      consumerAccountId,
    });
    await sendImessage({
      to: normalized,
      body: buildOptInMessage(product, confirmToken),
      label: "phone opt-in confirmation",
    });
    return res.json({ ok: true, pending: true });
  } catch (err) {
    req.log.error({ err }, "phone subscribe failed");
    return res.status(500).json({ error: "Failed" });
  }
});

// ── Public: confirm opt-in (token link from the confirmation text) ────────────
// Flips pending → active. Gated on status='pending' (the security boundary):
// an active row is idempotent success; an opted-out row must re-subscribe (a
// stale confirm link can't silently reactivate an opt-out).
function confirmPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Palonur</title></head>
<body style="margin:0;background:#FAF8F4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a0505;">
<div style="max-width:480px;margin:80px auto;padding:0 24px;text-align:center;">
  <p style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#8B1A1A;margin:0 0 10px;">Palonur</p>
  <p style="font-size:18px;line-height:1.6;">${message}</p>
</div></body></html>`;
}

router.get("/phone/confirm", async (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  try {
    const token = String(req.query.token ?? "").trim();
    if (!token) {
      return res.status(400).send(confirmPage("Invalid confirmation link."));
    }
    const rows = await db
      .select()
      .from(phoneSubscribersTable)
      .where(eq(phoneSubscribersTable.confirmToken, token))
      .limit(1);
    const sub = rows[0];
    if (!sub) {
      return res
        .status(404)
        .send(confirmPage("This confirmation link is no longer valid."));
    }
    if (sub.status === "active") {
      return res.send(confirmPage("You're confirmed. You'll hear from us."));
    }
    if (sub.status !== "pending") {
      // opted_out — a stale link can't reactivate.
      return res
        .status(410)
        .send(confirmPage("This confirmation link is no longer valid."));
    }
    await db
      .update(phoneSubscribersTable)
      .set({ status: "active", confirmedAt: new Date(), optedOutAt: null })
      .where(eq(phoneSubscribersTable.id, sub.id));
    return res.send(confirmPage("You're confirmed. You'll hear from us."));
  } catch (err) {
    req.log.error({ err }, "phone confirm failed");
    return res
      .status(500)
      .send(confirmPage("Something went wrong. Please try again later."));
  }
});

// ── Provider webhook: inbound replies (STOP / YES) ────────────────────────────
// Provider-agnostic: parses the number + message from either Sendblue
// ({ number, content, is_outbound }) or LoopMessage ({ recipient, text,
// alert_type }) shapes. STOP-family opts the number out across ALL products
// (the webhook doesn't carry a product); YES/START-family activates any pending
// rows for that number. Always 200s so the provider doesn't retry-storm.
router.post("/phone/webhook", async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Ignore our own outbound echoes (Sendblue flags is_outbound; LoopMessage
    // only fires this alert type for inbound).
    if (body.is_outbound === true) return res.json({ ok: true });
    if (
      typeof body.alert_type === "string" &&
      body.alert_type !== "message_inbound"
    ) {
      return res.json({ ok: true });
    }

    // When a webhook secret is configured, every inbound state-changing call
    // must present it — otherwise anyone could forge STOP/YES payloads and
    // alter a subscriber's consent status.
    const authed = webhookAuthentic(req);
    if (process.env.IMESSAGE_WEBHOOK_SECRET && !authed) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const rawNumber =
      (body.number as string) ??
      (body.from as string) ??
      (body.recipient as string) ??
      (body.phone as string) ??
      "";
    const rawText =
      (body.content as string) ??
      (body.text as string) ??
      (body.message as string) ??
      (body.body as string) ??
      "";
    const normalized = normalizeE164(String(rawNumber));
    if (!normalized) return res.json({ ok: true });

    const firstWord =
      String(rawText).trim().toLowerCase().split(/\s+/)[0] ?? "";

    if (STOP_WORDS.has(firstWord)) {
      await db
        .update(phoneSubscribersTable)
        .set({ status: "opted_out", optedOutAt: new Date() })
        .where(eq(phoneSubscribersTable.phone, normalized));
      req.log.info({ phone: "redacted" }, "phone opt-out via webhook");
      return res.json({ ok: true, action: "opted_out" });
    }

    if (START_WORDS.has(firstWord)) {
      // Activation asserts a confirmed consent, so we only honor a reply-based
      // YES/START when the webhook is cryptographically trusted. Without a
      // configured secret we can't verify the reply is genuine, so we refuse to
      // activate here — the token link in the opt-in text remains the trusted
      // confirmation path. (Opt-OUT above is always honored: opting out is the
      // fail-safe direction.)
      if (!authed) {
        req.log.warn("ignoring unauthenticated phone activation reply");
        return res.json({ ok: true, ignored: "unauthenticated" });
      }
      await db
        .update(phoneSubscribersTable)
        .set({ status: "active", confirmedAt: new Date(), optedOutAt: null })
        .where(
          and(
            eq(phoneSubscribersTable.phone, normalized),
            inArray(phoneSubscribersTable.status, ["pending", "opted_out"]),
          ),
        );
      return res.json({ ok: true, action: "activated" });
    }

    // ── Reply-as-doorway ─────────────────────────────────────────────────────
    // Any other inbound text is a potential despair-moment reply. Handing it
    // to the doorway pipeline triggers PAID outbound acks, so unlike the
    // fail-open STOP handling above this REQUIRES a cryptographically trusted
    // webhook: without a configured+matched secret, a forged payload could
    // drain the send budget. (With no secret configured, the doorway channel
    // is simply off; STOP/confirm-link flows are unaffected.)
    if (!authed) {
      return res.json({ ok: true, ignored: "unauthenticated" });
    }
    const doorway = await handleDoorwayInbound({
      phone: normalized,
      text: String(rawText),
      providerEventId: doorwayDedupKey(body, normalized, String(rawText)),
    });
    return res.json({ ok: true, doorway: doorway.outcome });
  } catch (err) {
    req.log.error({ err }, "phone webhook failed");
    // Still 200 so the provider doesn't retry-storm; we logged it.
    return res.json({ ok: true });
  }
});

// ── Admin: list captured numbers, filterable by product + status ──────────────
router.get(
  "/admin/phone-numbers",
  checkAdmin,
  async (req: Request, res: Response) => {
    try {
      const product = String(req.query.product ?? "").trim();
      const status = String(req.query.status ?? "").trim();
      const conds = [];
      if (product === "nightly") {
        conds.push(eq(phoneSubscribersTable.product, product));
      }
      if (
        status === "pending" ||
        status === "active" ||
        status === "opted_out"
      ) {
        conds.push(eq(phoneSubscribersTable.status, status));
      }
      const rows = await db
        .select()
        .from(phoneSubscribersTable)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(phoneSubscribersTable.createdAt));
      return res.json({ total: rows.length, entries: rows });
    } catch (err) {
      req.log.error({ err }, "phone admin list failed");
      return res.status(500).json({ error: "db error" });
    }
  },
);

// ── Admin: CSV export (honors the same product + status filters) ──────────────
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get(
  "/admin/phone-numbers.csv",
  checkAdmin,
  async (req: Request, res: Response) => {
    try {
      const product = String(req.query.product ?? "").trim();
      const status = String(req.query.status ?? "").trim();
      const conds = [];
      if (product === "nightly") {
        conds.push(eq(phoneSubscribersTable.product, product));
      }
      if (
        status === "pending" ||
        status === "active" ||
        status === "opted_out"
      ) {
        conds.push(eq(phoneSubscribersTable.status, status));
      }
      const rows = await db
        .select()
        .from(phoneSubscribersTable)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(phoneSubscribersTable.createdAt));

      const header = [
        "id",
        "phone",
        "product",
        "status",
        "source",
        "consent_at",
        "confirmed_at",
        "opted_out_at",
        "created_at",
      ];
      const lines = [header.join(",")];
      for (const r of rows) {
        lines.push(
          [
            csvCell(r.id),
            csvCell(r.phone),
            csvCell(r.product),
            csvCell(r.status),
            csvCell(r.source),
            csvCell(r.consentAt),
            csvCell(r.confirmedAt),
            csvCell(r.optedOutAt),
            csvCell(r.createdAt),
          ].join(","),
        );
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="phone-numbers.csv"`,
      );
      return res.send(lines.join("\n"));
    } catch (err) {
      req.log.error({ err }, "phone admin csv failed");
      return res.status(500).json({ error: "db error" });
    }
  },
);

export default router;
