/**
 * Approximate token-based chunker. Uses ~4 chars/token as a rough proxy
 * for OpenAI BPE tokens — close enough for chunk sizing and avoids a
 * tiktoken native dep.
 */
const CHARS_PER_TOKEN = 4;

export interface ChunkOptions {
  /** Target window size in tokens. */
  chunkTokens?: number;
  /** Overlap between adjacent windows in tokens. */
  overlapTokens?: number;
}

export function chunkText(
  text: string,
  opts: ChunkOptions = {},
): string[] {
  const chunkTokens = opts.chunkTokens ?? 500;
  const overlapTokens = opts.overlapTokens ?? 50;
  const chunkChars = chunkTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;

  const normalized = text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  if (normalized.length === 0) return [];

  // Walk paragraphs first so we don't chop mid-sentence when possible.
  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let buf = "";
  for (const p of paragraphs) {
    const candidate = buf.length === 0 ? p : `${buf}\n\n${p}`;
    if (candidate.length <= chunkChars) {
      buf = candidate;
      continue;
    }
    if (buf.length > 0) {
      chunks.push(buf);
      // Carry over the tail of the previous chunk for overlap.
      buf = buf.slice(Math.max(0, buf.length - overlapChars));
      buf = buf.length > 0 ? `${buf}\n\n${p}` : p;
    } else {
      buf = p;
    }
    // If a single paragraph itself exceeds the window, hard-split it.
    while (buf.length > chunkChars) {
      const slice = buf.slice(0, chunkChars);
      chunks.push(slice);
      buf = buf.slice(chunkChars - overlapChars);
    }
  }
  if (buf.trim().length > 0) chunks.push(buf);
  return chunks;
}
