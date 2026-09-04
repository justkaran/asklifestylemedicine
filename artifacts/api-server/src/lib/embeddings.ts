import { pipeline, env } from "@huggingface/transformers";
import {
  EMBEDDING_MODEL as LOCAL_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS as STORAGE_EMBEDDING_DIMENSIONS,
} from "@workspace/db/schema";
import { createHash } from "node:crypto";

/** `halfvec` is dimensionless, but every active retrieval cast is this width. */
export { STORAGE_EMBEDDING_DIMENSIONS };
export const EMBEDDING_DIMENSIONS = STORAGE_EMBEDDING_DIMENSIONS;
export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

export type EmbeddingProvider = "local" | "openai";
export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  /** Stored on each row; includes the provider to prevent space collisions. */
  identity: string;
}

export function getEmbeddingConfig(
  values: Record<string, string | undefined> = process.env,
): EmbeddingConfig {
  const requested = values.EMBEDDING_PROVIDER ?? "local";
  if (requested !== "local" && requested !== "openai") {
    throw new Error("EMBEDDING_PROVIDER must be either 'local' or 'openai'");
  }
  if (requested === "local") {
    // Preserve the historical local identity so existing gte-small rows remain
    // queryable without a pointless re-embedding migration. OpenAI uses a
    // provider-qualified identity and therefore cannot collide with this space.
    return { provider: "local", model: LOCAL_EMBEDDING_MODEL, dimensions: STORAGE_EMBEDDING_DIMENSIONS, identity: LOCAL_EMBEDDING_MODEL };
  }
  if (!values.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai (the Replit AI Integrations proxy does not support embeddings)");
  }
  const model = values.OPENAI_EMBEDDING_MODEL || OPENAI_EMBEDDING_MODEL;
  const dimensions = Number(values.OPENAI_EMBEDDING_DIMENSIONS || STORAGE_EMBEDDING_DIMENSIONS);
  if (!Number.isInteger(dimensions) || dimensions !== STORAGE_EMBEDDING_DIMENSIONS) {
    throw new Error(`OPENAI_EMBEDDING_DIMENSIONS must be ${STORAGE_EMBEDDING_DIMENSIONS} to match halfvec retrieval casts`);
  }
  return { provider: "openai", model, dimensions, identity: `openai:${model}:${dimensions}` };
}

const config = getEmbeddingConfig();
/** Active per-row model identity, not the static schema's local-model constant. */
export const EMBEDDING_MODEL = config.identity;

env.allowRemoteModels = true;
type Extractor = Awaited<ReturnType<typeof pipeline<"feature-extraction">>>;
let extractorPromise: Promise<Extractor> | null = null;
function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) extractorPromise = pipeline("feature-extraction", LOCAL_EMBEDDING_MODEL);
  return extractorPromise;
}

type FetchLike = typeof fetch;
function validateVectors(vectors: number[][], expectedCount: number, dimensions: number): number[][] {
  if (vectors.length !== expectedCount) throw new Error(`Embedding provider returned ${vectors.length} vectors for ${expectedCount} inputs`);
  vectors.forEach((vector, i) => {
    if (!Array.isArray(vector) || vector.length !== dimensions || vector.some((n) => !Number.isFinite(n))) {
      throw new Error(`Embedding provider returned invalid ${dimensions}-d vector at index ${i}`);
    }
  });
  return vectors;
}

export async function embedWithConfig(
  inputs: string[],
  activeConfig: EmbeddingConfig = config,
  fetchImpl: FetchLike = fetch,
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  if (activeConfig.provider === "local") {
    const extractor = await getExtractor();
    const out: number[][] = [];
    for (let i = 0; i < inputs.length; i += 32) {
      const rows = (await extractor(inputs.slice(i, i + 32), { pooling: "mean", normalize: true })).tolist() as number[][];
      out.push(...rows);
    }
    return validateVectors(out, inputs.length, activeConfig.dimensions);
  }
  // Deliberately call api.openai.com directly. AI Integrations does not expose
  // /v1/embeddings, even though it is OpenAI-compatible for chat APIs.
  const response = await fetchImpl("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: activeConfig.model, input: inputs, dimensions: activeConfig.dimensions }),
  });
  if (!response.ok) throw new Error(`OpenAI embeddings request failed (${response.status}): ${await response.text()}`);
  const body = await response.json() as { data?: Array<{ index?: number; embedding?: number[] }> };
  const data = body.data;
  if (!Array.isArray(data)) throw new Error("OpenAI embeddings response did not contain data");
  const ordered = data.map((item, position) => ({ item, position })).sort((a, b) => (a.item.index ?? a.position) - (b.item.index ?? b.position)).map(({ item }) => item.embedding ?? []);
  return validateVectors(ordered, inputs.length, activeConfig.dimensions);
}

export async function warmEmbedder(): Promise<void> {
  if (config.provider === "local") await getExtractor();
}
export async function embedTexts(inputs: string[]): Promise<number[][]> {
  return embedWithConfig(inputs);
}
export function toVectorLiteral(vec: number[]): string { return `[${vec.join(",")}]`; }
/** Stable, SQL-identifier-safe HNSW index name for an active embedding space. */
export function embeddingIndexName(table: "source_chunks" | "interpretation_chunks" | "agent_queries"): string {
  return `${table}_embedding_hnsw_${createHash("sha256").update(EMBEDDING_MODEL).digest("hex").slice(0, 12)}`;
}
export function embeddingSqlLiteral(): string { return EMBEDDING_MODEL.replace(/'/g, "''"); }
export function cosineSim(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}