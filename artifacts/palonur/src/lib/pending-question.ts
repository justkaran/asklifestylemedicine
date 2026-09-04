/**
 * The question a reader was holding when a paywall interrupted them.
 *
 * Saved (localStorage) the moment a paywall fires, then consumed exactly once
 * when the reader returns with an active subscription — the stored question is
 * appended as `?q=` to the post-purchase destination so the answer they paid
 * for fires automatically. The sleep surface already auto-fires ?q=.
 *
 * This is pure UX state: entitlement stays server-enforced by the paywall, so
 * a stale or forged value can never unlock anything.
 */
const KEY = "palonur_pending_question";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // a 3am question is stale by tomorrow night

export interface PendingQuestion {
  q: string;
  /** Internal destination whose ?q= auto-fire should receive it (e.g. "/sleep"). */
  path: string;
  ts: number;
}

export function savePendingQuestion(q: string, path: string): void {
  try {
    const trimmed = q.trim();
    if (!trimmed) return;
    localStorage.setItem(
      KEY,
      JSON.stringify({
        q: trimmed,
        path,
        ts: Date.now(),
      } satisfies PendingQuestion),
    );
  } catch {
    /* storage unavailable — the reader just retypes their question */
  }
}

export function readPendingQuestion(): PendingQuestion | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingQuestion>;
    if (
      typeof parsed?.q !== "string" ||
      !parsed.q.trim() ||
      typeof parsed.path !== "string" ||
      typeof parsed.ts !== "number"
    ) {
      localStorage.removeItem(KEY);
      return null;
    }
    if (Date.now() - parsed.ts > MAX_AGE_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return { q: parsed.q, path: parsed.path, ts: parsed.ts };
  } catch {
    return null;
  }
}

export function clearPendingQuestion(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/**
 * If a pending question is stored for exactly this destination, clear it and
 * return the destination with the question appended as ?q= (so the target
 * page auto-fires it). Otherwise return the destination unchanged.
 */
export function destinationWithPendingQuestion(dest: string): string {
  const pending = readPendingQuestion();
  if (!pending || pending.path !== dest) return dest;
  clearPendingQuestion();
  return `${dest}?q=${encodeURIComponent(pending.q)}`;
}
