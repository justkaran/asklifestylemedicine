import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db, investorDecksTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * Canonical investor decks. These map a stable slug → display metadata and the
 * source HTML file in the Palonur public folder. The portal NEVER serves these
 * straight off disk in production (the static files are stripped from the prod
 * build); instead `syncInvestorDecks()` copies the HTML into the
 * `investor_decks` table and the gated viewer streams it from there.
 */
export interface InvestorDeckDef {
  slug: string;
  title: string;
  description: string;
  file: string;
  /**
   * When set, the source HTML is run through `sanitizeForInvestor()` before
   * being stored in `investor_decks`. Used for docs that ship with a password
   * gate, an "enable editing" toolbar, and/or a cloud-sync collaboration script
   * which must all be neutralized for the per-investor read-only snapshot. Only
   * the DB copy is affected; the original public file is untouched.
   *
   * Rule of thumb: any deck whose source contains an editing/collab marker
   * (`#pw-gate`, `#edit-mode-btn`, `contenteditable`, or a cloud-sync endpoint
   * in `CLOUD_SYNC_MARKERS`) MUST set this. The static investor-* decks ship
   * none of those, so they are served verbatim. The investors test suite
   * enforces both halves of this invariant so the flag list can't silently fall
   * behind the source files.
   */
  sanitizeForInvestor?: boolean;
}

export const INVESTOR_DECKS: InvestorDeckDef[] = [
  {
    slug: "reach",
    title: "Reach Capital — Investor Deck",
    description: "The full narrative deck prepared for our lead investor.",
    file: "reach.html",
    // Ships the `/api/reach-deck` cloud-sync collaboration script + an
    // "Enable editing" toolbar with inline contenteditable.
    sanitizeForInvestor: true,
  },
  {
    slug: "reach-tech",
    title: "Technical Overview",
    description: "How the governed RAG platform works under the hood.",
    file: "reach-tech.html",
    // Ships the `/api/reach-tech` cloud-sync collaboration script + an "Enable
    // editing" toolbar with inline contenteditable.
    sanitizeForInvestor: true,
  },
  {
    slug: "business-plan",
    title: "Business Plan",
    description: "Market, model, and the path to revenue.",
    file: "business-plan.html",
    // Ships a `#pw-gate` password gate + an "Enable text editing" toolbar.
    sanitizeForInvestor: true,
  },
  {
    slug: "business-plan-slm",
    title: "SLM Business Plan",
    description:
      "The Palonur × Stanford Lifestyle Medicine partnership plan.",
    file: "business-plan-slm.html",
    sanitizeForInvestor: true,
  },
  {
    slug: "investor-deck",
    title: "Investor Deck — 10-Year Model",
    description: "Long-form deck with the ten-year cash-flow model.",
    file: "investor-deck.html",
    // Ships an "Enable editing" toolbar with inline contenteditable.
    sanitizeForInvestor: true,
  },
  {
    slug: "investor-scale-100m",
    title: "Day 1 to $100M",
    description: "How Palonur scales from launch to a $100M business.",
    file: "investor-scale-100m.html",
  },
  {
    slug: "investor-tech-moat",
    title: "Defensible Technology & Moat",
    description: "Why the platform is hard to copy.",
    file: "investor-tech-moat.html",
  },
  {
    slug: "investor-how-it-works",
    title: "How It Works",
    description: "The product, end to end, for a non-technical reader.",
    file: "investor-how-it-works.html",
  },
  {
    slug: "investor-user-journeys",
    title: "User Journeys",
    description: "What the experience looks like for each kind of user.",
    file: "investor-user-journeys.html",
  },
  {
    slug: "protocol",
    title: "Version Control for Science",
    description: "How the pillar approval process works, explained as code review.",
    file: "protocol.html",
    // Ships an "Enable editing" toolbar with inline contenteditable.
    sanitizeForInvestor: true,
  },
  {
    slug: "angels",
    title: "Angel One-Pager (EN)",
    description: "Single-page summary for angel investors.",
    file: "angels.html",
    // Ships an "Enable editing" toolbar with inline contenteditable.
    sanitizeForInvestor: true,
  },
  {
    slug: "angels-de",
    title: "Angel One-Pager (DE)",
    description: "German single-page summary for business angels.",
    file: "angels-de.html",
    // Ships an "Enable editing" toolbar with inline contenteditable.
    sanitizeForInvestor: true,
  },
];

/**
 * Cloud-sync endpoints that the editable decks POST/PUT their shared state to.
 * Any `<script>` that references one of these is a collaboration layer writing a
 * copy the founders share — it must never reach a granted investor.
 *
 * This list is matched as a literal substring by `sanitizeForInvestor`, so a
 * deck that renames its sync endpoint (e.g. `/api/reach-tech` → `/api/tech-doc`)
 * would silently stop being stripped. `findUncoveredCloudSyncEndpoints()` is the
 * canary: it re-derives the write endpoints straight from a deck's `fetch(...)`
 * calls and reports any that this list does not cover, so the investors test
 * suite fails loudly before a renamed link can leak to a granted investor.
 */
export const CLOUD_SYNC_MARKERS = [
  "/api/business-plan",
  "/api/reach-deck",
  "/api/reach-tech",
];

/**
 * Mutating HTTP methods. A `fetch(...)` to an `/api/...` endpoint with one of
 * these is a shared-state writer — the exact thing the investor snapshot must
 * not ship.
 */
const MUTATION_METHODS = /method\s*:\s*['"`](?:PUT|POST|PATCH|DELETE)['"`]/i;

/**
 * Re-derive the cloud-sync write endpoints a deck actually talks to and return
 * the ones `CLOUD_SYNC_MARKERS` does NOT cover.
 *
 * It resolves simple `const/let/var NAME = '/api/...'` bases (the decks build
 * their sync URL from such a base, e.g. `const API = '/api/business-plan'` then
 * `fetch(API + '/state', { method: 'PUT' })`), scans every `fetch(...)` whose
 * options carry a mutating method, resolves the first argument to its `/api/...`
 * base, and keeps any base not prefixed by a known marker. An empty array means
 * every shared-state writer in the deck is covered by the strip list; a
 * non-empty array is a renamed/new endpoint that would leak.
 */
export function findUncoveredCloudSyncEndpoints(html: string): string[] {
  const constMap = new Map<string, string>();
  const constRe =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"`](\/api\/[A-Za-z0-9_-]+)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = constRe.exec(html)) !== null) {
    constMap.set(m[1], m[2]);
  }

  const resolveBase = (arg: string): string | null => {
    const literal = arg.match(/['"`](\/api\/[A-Za-z0-9_-]+)/);
    if (literal) return literal[1];
    const ident = arg.match(/^\s*([A-Za-z_$][\w$]*)/);
    if (ident && constMap.has(ident[1])) return constMap.get(ident[1])!;
    return null;
  };

  const uncovered = new Set<string>();
  const fetchRe = /fetch\s*\(\s*([^,)]+)/g;
  while ((m = fetchRe.exec(html)) !== null) {
    // Look at a window after the URL arg for the request options' method.
    const window = html.slice(m.index, m.index + 300);
    if (!MUTATION_METHODS.test(window)) continue;
    const base = resolveBase(m[1]);
    if (!base) continue;
    if (!CLOUD_SYNC_MARKERS.some((marker) => base.startsWith(marker))) {
      uncovered.add(base);
    }
  }
  return [...uncovered];
}

/**
 * Produce the read-only investor-served snapshot of an editable deck.
 *
 * The editable decks in `artifacts/palonur/public` ship up to three things we
 * must not expose to a granted investor:
 *   1. A full-screen client-side password gate (`#pw-gate`). Access is already
 *      controlled by the per-investor deck grant, so the gate would just block
 *      them.
 *   2. An "enable editing" toolbar (`.toolbar` / `#edit-mode-btn`) plus inline
 *      `contenteditable` regions and per-card delete buttons.
 *   3. A cloud-sync collaboration `<script>` that reads/writes the founders'
 *      SHARED copy (e.g. `/api/business-plan` for the SLM plan, `/api/reach-deck`
 *      for the Reach narrative deck).
 *
 * This transform strips the cloud-sync `<script>`(s) and injects a `<head>`
 * style+script that hides the gate/toolbar/delete chrome, unlocks the gate
 * before the page's own `initGate()` runs (no scroll lock / no prompt), forces
 * every `contenteditable` region off at load, and neuters `toggleEditMode()`.
 * The served copy is therefore read-only and self-contained. Per-browser
 * localStorage what-if recompute is harmless and left intact. Only the DB
 * snapshot is changed; the on-disk public file is never modified.
 *
 * Note: hiding the chrome is unconditional, so it can never silently no-op. Only
 * the cloud-sync strip is string-anchored (`CLOUD_SYNC_MARKERS`); the investors
 * test suite asserts the markers are still present in each flagged source AND
 * that `findUncoveredCloudSyncEndpoints()` reports nothing for any flagged deck,
 * so a renamed or brand-new sync endpoint can't slip a shared-state writer into
 * the investor copy unnoticed.
 */
export function sanitizeForInvestor(html: string): string {
  let out = html;

  // 1. Strip every collaboration <script> block (the ones that talk to a shared
  //    cloud-sync endpoint). Walk from each marker out to its enclosing
  //    <script>...</script> and remove it. A while-loop handles a deck that
  //    references the same endpoint from more than one block.
  for (const marker of CLOUD_SYNC_MARKERS) {
    let markerIdx = out.indexOf(marker);
    while (markerIdx !== -1) {
      const scriptOpen = out.lastIndexOf("<script", markerIdx);
      const scriptCloseStart = out.indexOf("</script>", markerIdx);
      if (scriptOpen === -1 || scriptCloseStart === -1) break;
      const scriptClose = scriptCloseStart + "</script>".length;
      out = out.slice(0, scriptOpen) + out.slice(scriptClose);
      markerIdx = out.indexOf(marker);
    }
  }

  // 2. Neutralize the gate + every editing affordance. Injected into <head> so
  //    it applies from first paint. Setting the unlock flag before the page's
  //    own initGate() runs makes it short-circuit (no scroll lock). Forcing
  //    contenteditable off at load covers decks whose markup is statically
  //    editable (e.g. reach.html) once their own edit script is stripped.
  const inject = `
<style id="investor-readonly">
  #pw-gate{display:none!important}
  #edit-mode-btn{display:none!important}
  .toolbar{display:none!important}
  .delete-btn{display:none!important}
  [contenteditable]:hover,[contenteditable]:focus{background:none!important;box-shadow:none!important;outline:none!important}
</style>
<script>
  try{ sessionStorage.setItem('palonur-bp-unlocked','1'); }catch(e){}
  window.addEventListener('DOMContentLoaded',function(){
    var g=document.getElementById('pw-gate'); if(g&&g.parentNode){ g.parentNode.removeChild(g); }
    document.body.style.overflow='';
    try{ document.querySelectorAll('[contenteditable]').forEach(function(el){ el.setAttribute('contenteditable','false'); }); }catch(e){}
    window.toggleEditMode=function(){};
  });
</script>
`;
  if (out.includes("</head>")) {
    out = out.replace("</head>", `${inject}</head>`);
  } else {
    out = inject + out;
  }
  return out;
}

let cachedPublicDir: string | null | undefined;

/** Walk up from this module to locate artifacts/palonur/public. */
async function findPublicDir(): Promise<string | null> {
  if (cachedPublicDir !== undefined) return cachedPublicDir;
  const start = path.dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "artifacts", "palonur", "public");
    try {
      const st = await fs.stat(candidate);
      if (st.isDirectory()) {
        cachedPublicDir = candidate;
        return candidate;
      }
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedPublicDir = null;
  return null;
}

/**
 * Upsert every canonical deck into `investor_decks`. Metadata (slug/title/
 * description) is always written; `html` is updated only when the source file
 * is found on disk so a missing folder in production never wipes existing HTML.
 * Best-effort: logs and returns instead of throwing.
 */
export async function syncInvestorDecks(): Promise<{
  synced: number;
  withHtml: number;
}> {
  const publicDir = await findPublicDir();
  let synced = 0;
  let withHtml = 0;
  for (const deck of INVESTOR_DECKS) {
    let html: string | null = null;
    if (publicDir) {
      try {
        html = await fs.readFile(path.join(publicDir, deck.file), "utf8");
        if (html != null && deck.sanitizeForInvestor) {
          html = sanitizeForInvestor(html);
        }
      } catch {
        html = null;
      }
    }
    const update: Record<string, unknown> = {
      title: deck.title,
      description: deck.description,
    };
    if (html != null) update.html = html;
    try {
      await db
        .insert(investorDecksTable)
        .values({
          slug: deck.slug,
          title: deck.title,
          description: deck.description,
          html,
        })
        .onConflictDoUpdate({
          target: investorDecksTable.slug,
          set: update,
        });
      synced++;
      if (html != null) withHtml++;
    } catch (e) {
      logger.error({ err: e, slug: deck.slug }, "Failed to sync investor deck");
    }
  }
  logger.info({ synced, withHtml }, "Investor decks synced");
  return { synced, withHtml };
}
