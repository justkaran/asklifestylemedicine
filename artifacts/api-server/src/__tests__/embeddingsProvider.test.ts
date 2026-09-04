import { describe, expect, it, vi } from "vitest";
import {
  EMBEDDING_DIMENSIONS,
  embedWithConfig,
  getEmbeddingConfig,
  type EmbeddingConfig,
} from "../lib/embeddings";

describe("embedding provider configuration", () => {
  it("keeps local embeddings as the explicit/default development provider", () => {
    expect(getEmbeddingConfig({}).identity).toBe("Xenova/gte-small");
    expect(getEmbeddingConfig({ EMBEDDING_PROVIDER: "local" }).provider).toBe("local");
  });

  it("selects direct OpenAI with a provider/model/dimension identity", () => {
    expect(getEmbeddingConfig({ EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: "key" })).toEqual({
      provider: "openai", model: "text-embedding-3-small", dimensions: 384,
      identity: "openai:text-embedding-3-small:384",
    });
    expect(() => getEmbeddingConfig({ EMBEDDING_PROVIDER: "openai" })).toThrow("OPENAI_API_KEY");
    expect(() => getEmbeddingConfig({ EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: "key", OPENAI_EMBEDDING_DIMENSIONS: "512" })).toThrow("384");
  });

  it("posts to the direct endpoint and rejects incorrect vector widths", async () => {
    const config: EmbeddingConfig = { provider: "openai", model: "text-embedding-3-small", dimensions: EMBEDDING_DIMENSIONS, identity: "openai:text-embedding-3-small:384" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 1, embedding: Array(384).fill(2) }, { index: 0, embedding: Array(384).fill(1) }],
    }), { status: 200 }));
    const rows = await embedWithConfig(["first", "second"], config, fetchMock as typeof fetch);
    expect(fetchMock).toHaveBeenCalledWith("https://api.openai.com/v1/embeddings", expect.any(Object));
    expect(rows[0][0]).toBe(1);
    const wrongWidthFetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] })),
    );
    await expect(
      embedWithConfig(["x"], config, wrongWidthFetch as typeof fetch),
    ).rejects.toThrow("invalid 384-d vector");
  });
});