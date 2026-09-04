import { beforeAll, describe, expect, test, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

vi.mock("../lib/embeddings.js", () => ({
  EMBEDDING_MODEL: "Xenova/gte-small",
  EMBEDDING_DIMENSIONS: 384,
  embedTexts: async (texts: string[]) => texts.map(() => [1, ...new Array(383).fill(0)]),
  toVectorLiteral: (v: number[]) => `[${v.join(",")}]`,
}));

import {
  db, facultyUsersTable, interpretationChunksTable, interpretationsTable,
  pillarsTable, sourceChunksTable, sourcesTable,
} from "@workspace/db";
import { autoApproveDiscoveredInterpretation } from "../lib/autoApproveDiscoveredInterpretation.js";

describe("auto-approved discovered interpretation retention", () => {
  beforeAll(ensureCaptureLoopSchema);

  test("keeps the approved claim indexed while purging all no-rights source passages", async () => {
    const suffix = `discovery-retention-${Date.now()}`;
    const [pillar] = await db.insert(pillarsTable).values({ slug: suffix, name: "Sleep intervention", description: "sleep intervention" }).returning();
    const [user] = await db.insert(facultyUsersTable).values({ clerkUserId: suffix, email: `${suffix}@example.test`, fullName: "Discovery Steward" }).returning();
    const [source] = await db.insert(sourcesTable).values({
      pillarId: pillar!.id, kind: "paper", title: "Sleep intervention study",
      abstract: "A source passage that must be purged.", fullText: "A source passage that must be purged.",
      rightsBasis: "no_documented_full_text_rights", retentionStatus: "review_window",
      uploadedByUserId: user!.id, status: "draft",
    }).returning();
    await db.insert(sourceChunksTable).values({
      sourceId: source!.id, chunkIndex: 0, text: "A source passage that must be purged.",
      embedding: [1, ...new Array(383).fill(0)], embeddingModel: "Xenova/gte-small",
    });
    const [interp] = await db.insert(interpretationsTable).values({
      sourceId: source!.id, pillarId: pillar!.id, origin: "palonur_ai", status: "proposed",
      answer: "What does this sleep study suggest?",
      interpretation: "The study suggests a sleep intervention may help, while its findings should be interpreted cautiously.",
      aiDraft: "The study suggests a sleep intervention may help, while its findings should be interpreted cautiously.",
    }).returning();

    await autoApproveDiscoveredInterpretation({ sourceId: source!.id, interpretationId: interp!.id });

    const [approvedSource] = await db.select().from(sourcesTable).where(eq(sourcesTable.id, source!.id));
    const [approvedInterp] = await db.select().from(interpretationsTable).where(eq(interpretationsTable.id, interp!.id));
    const remainingSourceChunks = await db.select().from(sourceChunksTable).where(eq(sourceChunksTable.sourceId, source!.id));
    const claimChunks = await db.select().from(interpretationChunksTable).where(and(eq(interpretationChunksTable.sourceId, source!.id), eq(interpretationChunksTable.interpretationId, interp!.id)));
    expect(approvedSource).toMatchObject({ status: "approved", retentionStatus: "purged_no_full_text_rights", fullText: null, abstract: null });
    expect(approvedInterp?.status).toBe("approved");
    expect(remainingSourceChunks).toHaveLength(0);
    expect(claimChunks.length).toBeGreaterThan(0);
  });
});