/**
 * App-wide serving mode.
 *
 * This build is the standalone Stanford Lifestyle Medicine product.
 * Only the Ask Lifestyle Medicine experience and its supporting legal and
 * answer-link routes are exposed. The former Palonur site is no longer served.
 *
 * In production the palonur Node server decides by request Host (SLM_DOMAIN
 * env var) and injects `<meta name="palonur-app-mode" content="slm">` into
 * index.html. The client reads that marker once at boot.
 *
 * When there is no host dispatch (dev server, workspace preview of the
 * production build), `?slmHost=1` forces standalone mode for manual testing.
 * This is safe to expose in production builds: standalone mode only changes
 * client chrome/routing — all gating (registration, history, limits) is
 * server-enforced.
 */

/** Pure detection logic — exported for unit tests. */
export function detectSlmStandalone(
  doc: Pick<Document, "querySelector"> | undefined,
  search: string,
): boolean {
  if (!doc) return false;
  return (
    doc
      .querySelector('meta[name="palonur-app-mode"]')
      ?.getAttribute("content") === "slm" ||
    new URLSearchParams(search).has("slmHost")
  );
}

export const SLM_STANDALONE = true;
