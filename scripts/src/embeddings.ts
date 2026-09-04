// Keep seed/re-embedding behavior aligned with api-server without importing an
// artifact package (workspace package boundaries prohibit that dependency).
import { pipeline, env } from "@huggingface/transformers";
import { EMBEDDING_MODEL as LOCAL_MODEL, EMBEDDING_DIMENSIONS as STORAGE_EMBEDDING_DIMENSIONS } from "@workspace/db/schema";

export const EMBEDDING_DIMENSIONS = STORAGE_EMBEDDING_DIMENSIONS;
export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const provider = process.env.EMBEDDING_PROVIDER ?? "local";
if (provider !== "local" && provider !== "openai") throw new Error("EMBEDDING_PROVIDER must be 'local' or 'openai'");
if (provider === "openai" && !process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai");
const openaiModel = process.env.OPENAI_EMBEDDING_MODEL || OPENAI_EMBEDDING_MODEL;
const requestedDimensions = Number(process.env.OPENAI_EMBEDDING_DIMENSIONS || STORAGE_EMBEDDING_DIMENSIONS);
if (provider === "openai" && requestedDimensions !== STORAGE_EMBEDDING_DIMENSIONS) throw new Error(`OPENAI_EMBEDDING_DIMENSIONS must be ${STORAGE_EMBEDDING_DIMENSIONS}`);
// Keep the established local identity backward compatible. OpenAI's identity
// is provider-qualified, so switching providers still requires explicit
// re-embedding and can never mix vector spaces.
export const EMBEDDING_MODEL = provider === "openai" ? `openai:${openaiModel}:${requestedDimensions}` : LOCAL_MODEL;

env.allowRemoteModels = true;
type Extractor = Awaited<ReturnType<typeof pipeline<"feature-extraction">>>;
let extractorPromise: Promise<Extractor> | null = null;
function extractor() { return extractorPromise ??= pipeline("feature-extraction", LOCAL_MODEL); }
function validate(rows: number[][], count: number): number[][] {
  if (rows.length !== count || rows.some((r) => r.length !== EMBEDDING_DIMENSIONS || r.some((x) => !Number.isFinite(x)))) throw new Error(`Embedding provider returned invalid ${EMBEDDING_DIMENSIONS}-d vectors`);
  return rows;
}
export async function embedTexts(inputs: string[]): Promise<number[][]> {
  if (!inputs.length) return [];
  if (provider === "local") {
    const e = await extractor(); const rows: number[][] = [];
    for (let i = 0; i < inputs.length; i += 32) rows.push(...((await e(inputs.slice(i, i + 32), { pooling: "mean", normalize: true })).tolist() as number[][]));
    return validate(rows, inputs.length);
  }
  const response = await fetch("https://api.openai.com/v1/embeddings", { method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: openaiModel, input: inputs, dimensions: EMBEDDING_DIMENSIONS }) });
  if (!response.ok) throw new Error(`OpenAI embeddings request failed (${response.status}): ${await response.text()}`);
  const data = (await response.json() as { data?: Array<{ index: number; embedding: number[] }> }).data;
  if (!Array.isArray(data)) throw new Error("OpenAI embeddings response did not contain data");
  return validate(data.sort((a, b) => a.index - b.index).map((x) => x.embedding), inputs.length);
}
export function toVectorLiteral(vec: number[]): string { return `[${vec.join(",")}]`; }