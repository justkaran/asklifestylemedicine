import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import sanitizeHtml from "sanitize-html";
import pool from "../lib/db.js";
import { getOtlOverview } from "../lib/otlOverview.js";
import { getIp, geoLookup } from "../lib/geo.js";

const router: IRouter = Router();

const OTL_COOKIE = "otl_session";

/**
 * Edit password for the private docs (OTL brief + UIT package), resolved at
 * request time. FAIL CLOSED in production: if the secret is unset, editing is
 * denied entirely rather than falling back to a source-visible default. The
 * dev fallback keeps local editing frictionless.
 */
function checkEditPassword(req: Request, res: Response): boolean {
  const configured = process.env["OTL_EDIT_PASSWORD"]?.trim();
  if (!configured && process.env.NODE_ENV === "production") {
    res.status(503).json({ error: "Editing is not configured" });
    return false;
  }
  const expected = configured || "palonureditor";
  const password = (req.header("x-edit-password") ?? "").toString().trim();
  if (password !== expected) {
    res.status(401).json({ error: "Invalid edit password" });
    return false;
  }
  return true;
}

/**
 * Sanitize saved doc pages on WRITE. The brief pages are re-inserted with
 * innerHTML when loaded, so persisted markup must never carry active content:
 * no scripts, no event-handler attributes (onclick etc.), no javascript: URLs,
 * no iframes/objects. The pages' own delete buttons historically used inline
 * onclick — both pages now use delegated click handling, so stripping event
 * attributes is safe.
 */
const DOC_SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    "section", "div", "span", "h1", "h2", "h3", "h4", "h5", "p", "ul", "ol",
    "li", "strong", "em", "b", "i", "u", "code", "pre", "br", "hr", "a",
    "button", "table", "thead", "tbody", "tr", "th", "td", "dl", "dt", "dd",
    "img", "blockquote", "sup", "sub", "small", "figure", "figcaption",
  ],
  allowedAttributes: {
    "*": ["class", "style", "id", "data-card", "title", "aria-*", "role"],
    a: ["href", "target", "rel"],
    img: ["src", "alt", "width", "height"],
    button: ["type"],
    th: ["colspan", "rowspan", "scope"],
    td: ["colspan", "rowspan"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["http", "https", "data"] },
};

function sanitizePages(pages: string[]): string[] {
  return pages.map((p) => sanitizeHtml(p, DOC_SANITIZE_OPTS));
}

const DOC_ID = "otl";

/**
 * Stanford OTL governance dashboard — server-side password gate.
 *
 * Access model (chosen for speed, see Task spec): ONE shared password that Karan
 * hands to OTL, validated here and exchanged for a signed, time-limited
 * `otl_session` cookie. The guard ALSO accepts the existing platform-admin
 * cookie so a signed-in admin opens the dashboard without re-entering the
 * password. There is no per-person OTL account and no new auth table.
 *
 * Gating is enforced on the SERVER for every data endpoint: when the password
 * env var is unset we deny cleanly rather than exposing data, so the dashboard
 * can never leak by misconfiguration.
 */

function configuredPassword(): string | null {
  const pw = process.env["OTL_DASHBOARD_PASSWORD"];
  if (!pw || !pw.trim()) return null;
  return pw;
}

function hasOtlAccess(req: Request): boolean {
  // Platform admins are a separately-controlled credential — always allowed.
  if (req.signedCookies?.palonur_admin === "1") return true;
  // Fail closed: an OTL session cookie only grants access while the shared
  // password is actually configured. Otherwise a stale, still-signed cookie
  // would keep the dashboard open after the password was cleared.
  if (!configuredPassword()) return false;
  return req.signedCookies?.[OTL_COOKIE] === "1";
}

function requireOtl(req: Request, res: Response, next: NextFunction) {
  if (hasOtlAccess(req)) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// ---------------------------------------------------------------------------
// OTL brief doc — editable private one-pager (otl.html companion).
// ---------------------------------------------------------------------------

router.get("/otl-doc", async (req: Request, res: Response) => {
  // This is a private brief surfaced from the OTL governance dashboard. In
  // production the page (otl.html) is gated at the edge to authenticated OTL
  // sessions; mirror that here so its content is served ONLY to a signed-in
  // OTL/admin session and a public request gets a clean 404. Dev editing stays
  // open.
  if (process.env.NODE_ENV === "production" && !hasOtlAccess(req)) {
    return res.status(404).json({ error: "Not found" });
  }
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  try {
    const result = await pool.query(
      "SELECT content, updated_at FROM otl_doc WHERE id = $1",
      [DOC_ID],
    );
    if (result.rows.length === 0) {
      return res.json({ content: null, updatedAt: null });
    }
    return res.json({
      content: result.rows[0].content,
      updatedAt: result.rows[0].updated_at,
    });
  } catch {
    return res.status(500).json({ error: "Failed to load OTL doc" });
  }
});

router.put("/otl-doc", async (req, res) => {
  // In production, mutating a governed doc requires BOTH an authenticated
  // OTL/admin session AND the edit password — the edit password alone is not
  // equivalent to viewer privileges.
  if (process.env.NODE_ENV === "production" && !hasOtlAccess(req)) {
    return res.status(404).json({ error: "Not found" });
  }
  if (!checkEditPassword(req, res)) return;
  const { content } = req.body ?? {};
  if (!Array.isArray(content)) {
    return res
      .status(400)
      .json({ error: "Invalid payload: expected { content: string[] }" });
  }
  if (!content.every((c) => typeof c === "string")) {
    return res
      .status(400)
      .json({ error: "Invalid payload: content must be array of strings" });
  }
  try {
    await pool.query(
      `INSERT INTO otl_doc (id, content, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET content = $2::jsonb, updated_at = NOW()`,
      [DOC_ID, JSON.stringify(sanitizePages(content))],
    );
    return res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch {
    return res.status(500).json({ error: "Failed to save OTL doc" });
  }
});

// ---------------------------------------------------------------------------
// UIT review package doc — same snapshot pattern, second document id.
// ---------------------------------------------------------------------------

const UIT_DOC_ID = "uit";

router.get("/uit-doc", async (req: Request, res: Response) => {
  // Mirrors /otl-doc exactly: private content served only to an OTL/admin
  // session in production (clean 404 otherwise); dev editing stays open.
  if (process.env.NODE_ENV === "production" && !hasOtlAccess(req)) {
    return res.status(404).json({ error: "Not found" });
  }
  // Audit: opening the UIT package is a governed-document access, logged the
  // same deduped way as an OTL dashboard open (best-effort, non-blocking).
  recordOtlAccess(req);
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  try {
    const result = await pool.query(
      "SELECT content, updated_at FROM otl_doc WHERE id = $1",
      [UIT_DOC_ID],
    );
    if (result.rows.length === 0) {
      return res.json({ content: null, updatedAt: null });
    }
    return res.json({
      content: result.rows[0].content,
      updatedAt: result.rows[0].updated_at,
    });
  } catch {
    return res.status(500).json({ error: "Failed to load UIT doc" });
  }
});

router.put("/uit-doc", async (req, res) => {
  // Same rule as /otl-doc: session + edit password in production.
  if (process.env.NODE_ENV === "production" && !hasOtlAccess(req)) {
    return res.status(404).json({ error: "Not found" });
  }
  if (!checkEditPassword(req, res)) return;
  const { content } = req.body ?? {};
  if (!Array.isArray(content)) {
    return res
      .status(400)
      .json({ error: "Invalid payload: expected { content: string[] }" });
  }
  if (!content.every((c) => typeof c === "string")) {
    return res
      .status(400)
      .json({ error: "Invalid payload: content must be array of strings" });
  }
  try {
    await pool.query(
      `INSERT INTO otl_doc (id, content, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET content = $2::jsonb, updated_at = NOW()`,
      [UIT_DOC_ID, JSON.stringify(sanitizePages(content))],
    );
    return res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch {
    return res.status(500).json({ error: "Failed to save UIT doc" });
  }
});

// ---------------------------------------------------------------------------
// OTL governance dashboard — password gate + read-only aggregate.
// ---------------------------------------------------------------------------

/**
 * Record a successful OTL dashboard login for the admin access audit.
 *
 * Fully best-effort and non-blocking: a failure here (missing table, geo
 * service down) must NEVER stop a legitimate login, so it runs after the
 * response is sent and swallows all errors. IP + user-agent are captured
 * synchronously; the coarse city/country is filled in asynchronously.
 */
function recordOtlLogin(req: Request): void {
  const ip = getIp(req);
  const userAgent = (req.headers["user-agent"] ?? "").toString().slice(0, 1000);
  pool
    .query(
      `INSERT INTO otl_login_events (via, ip, user_agent)
       VALUES ('password', $1, $2) RETURNING id`,
      [ip || null, userAgent || null],
    )
    .then((r) => {
      const id = r.rows[0]?.id as number | undefined;
      if (!id) return;
      return geoLookup(ip).then((geo) => {
        if (!geo) return;
        return pool.query(
          `UPDATE otl_login_events
             SET country = $1, country_code = $2, city = $3
           WHERE id = $4`,
          [geo.country, geo.country_code, geo.city, id],
        );
      });
    })
    .catch((err) => {
      req.log?.warn({ err }, "otl: failed to record login event");
    });
}

/**
 * Record that an OTL session OPENED the dashboard, distinct from a fresh
 * password login. The `otl_session` cookie lasts 8 hours and the SPA skips the
 * password form while it is valid, so a returning OTL user re-opening the
 * dashboard never hits POST /otl-auth and would otherwise leave NO audit trail
 * at all. We log a coarse `via='session'` access event so the admin can still
 * see when OTL came back.
 *
 * Two safeguards keep the audit honest:
 *  - Only a genuine OTL session is logged (the `otl_session` cookie). We do NOT
 *    exclude the platform admin: an OTL session opening the dashboard is a real
 *    open regardless of whether the same browser also holds an admin cookie, and
 *    the admin needs to be able to verify the audit works by opening it.
 *  - Deduplicated to at most one row per IP per hour (across ANY `via`), so a
 *    password login followed immediately by the dashboard's overview fetch
 *    counts once, and refreshes/re-opens within the hour don't spam the log.
 *
 * Best-effort and non-blocking, exactly like recordOtlLogin.
 */
function recordOtlAccess(req: Request): void {
  // Only a genuine OTL session counts as an OTL dashboard open.
  if (req.signedCookies?.[OTL_COOKIE] !== "1") return;
  const ip = getIp(req);
  const userAgent = (req.headers["user-agent"] ?? "").toString().slice(0, 1000);
  pool
    .query(
      `INSERT INTO otl_login_events (via, ip, user_agent)
       SELECT 'session', $1, $2
        WHERE NOT EXISTS (
          SELECT 1 FROM otl_login_events
           WHERE ip IS NOT DISTINCT FROM $1
             AND created_at > NOW() - INTERVAL '1 hour'
        )
       RETURNING id`,
      [ip || null, userAgent || null],
    )
    .then((r) => {
      const id = r.rows[0]?.id as number | undefined;
      if (!id) return; // deduped within the window — no new row inserted
      return geoLookup(ip).then((geo) => {
        if (!geo) return;
        return pool.query(
          `UPDATE otl_login_events
             SET country = $1, country_code = $2, city = $3
           WHERE id = $4`,
          [geo.country, geo.country_code, geo.city, id],
        );
      });
    })
    .catch((err) => {
      req.log?.warn({ err }, "otl: failed to record dashboard access");
    });
}

// Exchange the shared password for a signed 8-hour session cookie.
router.post("/otl-auth", (req: Request, res: Response) => {
  const expected = configuredPassword();
  if (!expected) {
    // Deny cleanly when unconfigured — never fall back to an open dashboard.
    req.log?.warn("OTL dashboard password not configured; denying access");
    return res
      .status(503)
      .json({ ok: false, error: "OTL dashboard is not configured yet." });
  }
  const { password } = req.body as { password?: string };
  if (!password || password.trim() !== expected) {
    return res.status(401).json({ ok: false, error: "Incorrect password" });
  }
  res.cookie(OTL_COOKIE, "1", {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  });
  recordOtlLogin(req);
  return res.json({ ok: true });
});

router.delete("/otl-auth", (_req: Request, res: Response) => {
  res.clearCookie(OTL_COOKIE);
  return res.json({ ok: true });
});

// Bridge check: lets the SPA skip the password prompt when the caller already
// holds a valid OTL or platform-admin cookie.
router.get("/otl-auth/session", (req: Request, res: Response) => {
  return res.json({ authed: hasOtlAccess(req) });
});

// The single read-only aggregate the dashboard renders.
router.get("/otl/overview", requireOtl, async (req: Request, res: Response) => {
  try {
    // Log the dashboard open for the admin audit (deduped, OTL sessions only).
    recordOtlAccess(req);
    res.set("Cache-Control", "no-store");
    const overview = await getOtlOverview();
    return res.json(overview);
  } catch (err) {
    req.log?.error({ err }, "otl: failed to build overview");
    return res.status(500).json({ error: "Failed to load dashboard data" });
  }
});

export default router;
