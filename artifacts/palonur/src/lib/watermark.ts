// Invisible text watermark for Palonur content.
//
// Encodes a short payload (e.g. "palonur:slm") as a run of zero-width
// characters that survives verbatim copy-paste but is invisible to readers:
//   \u200B (zero-width space)      -> start/end marker
//   \u200C (zero-width non-joiner) -> bit 0
//   \u200D (zero-width joiner)     -> bit 1
//
// Honest limits (by design, documented for future work): the mark only
// survives verbatim copy-paste. Retyping, paraphrasing, screenshots, or a
// deliberate strip of zero-width characters removes it.

const MARK = "\u200B";
const ZERO = "\u200C";
const ONE = "\u200D";

const ZW_RUN = /\u200B([\u200C\u200D]+)\u200B/g;
const ZW_ANY = /[\u200B\u200C\u200D]/g;

// Payloads are short ("palonur:<path>"); cap run size BEFORE decoding so a
// hostile document can't make us allocate for an unbounded zero-width run.
const MAX_BITS = 200 * 8;

export function encodeWatermark(payload: string): string {
  const bytes = new TextEncoder().encode(payload);
  let bits = "";
  for (const b of bytes) {
    for (let i = 7; i >= 0; i--) bits += (b >> i) & 1 ? ONE : ZERO;
  }
  return MARK + bits + MARK;
}

function decodeBits(bits: string): string | null {
  if (bits.length < 8 || bits.length > MAX_BITS || bits.length % 8 !== 0) return null;
  const bytes = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bytes.length; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i * 8 + j] === ONE ? 1 : 0);
    bytes[i] = b;
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // Sanity: payloads are short printable strings.
    if (!decoded || /[\u0000-\u0008\u000E-\u001F]/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Scan ALL framed zero-width runs (a malformed earlier run must not mask a
 * later valid mark) and return the first that decodes cleanly. This is an
 * UNVERIFIED marker, not proof of origin: anyone who knows the scheme can
 * forge or strip it.
 */
export function extractWatermark(text: string): string | null {
  ZW_RUN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ZW_RUN.exec(text)) !== null) {
    const decoded = decodeBits(m[1]);
    if (decoded !== null) return decoded;
  }
  return null;
}

/** Like extractWatermark, but only accepts our own "palonur:" payloads. */
export function extractPalonurWatermark(text: string): string | null {
  ZW_RUN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ZW_RUN.exec(text)) !== null) {
    const decoded = decodeBits(m[1]);
    if (decoded !== null && decoded.startsWith("palonur:")) return decoded;
  }
  return null;
}

export function stripWatermark(text: string): string {
  return text.replace(ZW_ANY, "");
}

/** Insert the invisible signature after the first word (or at the start). */
export function watermarkText(text: string, payload: string): string {
  const sig = encodeWatermark(payload);
  const firstSpace = text.indexOf(" ");
  if (firstSpace > 0) return text.slice(0, firstSpace) + sig + text.slice(firstSpace);
  return sig + text;
}

function isEditable(node: unknown): boolean {
  if (!(node instanceof HTMLElement)) return false;
  // isContentEditable already reflects editable ANCESTRY for contenteditable
  // regions; inputs/textareas are direct targets.
  return (
    node instanceof HTMLInputElement ||
    node instanceof HTMLTextAreaElement ||
    node.isContentEditable
  );
}

/** True when the copy originates from any editable surface (target, composed path, or selection anchor ancestry). */
function copyIsFromEditable(e: ClipboardEvent, sel: Selection): boolean {
  if (isEditable(e.target)) return true;
  // Shadow DOM: the plain target is retargeted to the host; walk the composed path.
  if (typeof e.composedPath === "function") {
    for (const n of e.composedPath()) if (isEditable(n)) return true;
  }
  const anchorEl =
    sel.anchorNode instanceof HTMLElement ? sel.anchorNode : sel.anchorNode?.parentElement;
  return isEditable(anchorEl ?? null);
}

const MIN_COPY_LENGTH = 60;

/**
 * Install a document-level copy handler that injects the invisible signature
 * into copied text. Skips copies from inputs/textareas (the user's own text)
 * and very short snippets. Returns a cleanup function.
 */
export function installCopyWatermark(getPayload: () => string): () => void {
  const onCopy = (e: ClipboardEvent) => {
    try {
      if (e.defaultPrevented) return; // respect other copy handlers
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      if (copyIsFromEditable(e, sel)) return;
      const plain = sel.toString();
      if (plain.trim().length < MIN_COPY_LENGTH) return;
      if (!e.clipboardData) return;

      const marked = watermarkText(plain, getPayload());

      // Preserve rich formatting where possible: serialize the selection and
      // append the invisible signature (valid text characters in HTML).
      let html = "";
      try {
        const container = document.createElement("div");
        for (let i = 0; i < sel.rangeCount; i++) {
          container.appendChild(sel.getRangeAt(i).cloneContents());
        }
        html = container.innerHTML;
      } catch {
        html = "";
      }

      e.preventDefault();
      e.clipboardData.setData("text/plain", marked);
      if (html) e.clipboardData.setData("text/html", html + encodeWatermark(getPayload()));
    } catch {
      // Never break copying: on any error, fall back to the browser default.
    }
  };
  document.addEventListener("copy", onCopy);
  return () => document.removeEventListener("copy", onCopy);
}
