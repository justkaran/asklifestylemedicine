import { seedStewardRoster } from "@workspace/db/seeds/steward-roster";
import { logger } from "./logger";

/**
 * Best-effort, idempotent boot seed for the steward roster.
 *
 * Publishing migrates schema, not row data, and the sign-in allowlist only
 * provisions a steward when the person actually signs in — so the published
 * Stanford Lifestyle Medicine pillar Heads (plus Karen Parker on Autism and
 * the operator on the AI Lab pillar) would stay invisible in production until
 * their first login. This seed ensures their pending faculty rows + steward
 * memberships on every boot. Pure DB writes, no embeddings, fire-and-forget.
 */
export async function seedStewards(): Promise<void> {
  const result = await seedStewardRoster({
    info: (msg) => logger.info(msg),
    warn: (msg) => logger.warn(msg),
  });
  logger.info(
    {
      ensured: result.ensured.length,
      skippedPillars: result.skippedPillars,
    },
    "Steward roster seed finished",
  );
}
