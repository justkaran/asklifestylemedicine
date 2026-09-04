import { Router, type IRouter, type Request } from "express";
import { createHash } from "node:crypto";
import { sql, eq } from "drizzle-orm";
import { db, answerFormatVotesTable } from "@workspace/db";
import { checkAdmin } from "./admin";

/**
 * Answer-format preference poll ("What do you like more: avatar, podcast,
 * text?") shown under agent answers.
 *
 * - POST /api/format-votes    — anonymous vote; one vote per visitor (IP-hash
 *   upsert, so re-voting changes the choice instead of stuffing the ballot).
 * - GET  /api/admin/format-votes — tallies for the admin graph (admin cookie).
 */
const router: IRouter = Router();

const OPTIONS = ["avatar", "podcast", "text"] as const;
type FormatOption = (typeof OPTIONS)[number];

const HASH_SALT = process.env.SESSION_SECRET ?? "palonur-dev-salt";

function voterHash(req: Request): string {
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown";
  return createHash("sha256").update(ip + ":" + HASH_SALT).digest("hex");
}

async function loadCounts(): Promise<{
  counts: Record<FormatOption, number>;
  total: number;
  lastVoteAt: string | null;
}> {
  const rows = await db
    .select({
      option: answerFormatVotesTable.option,
      count: sql<number>`count(*)::int`,
      last: sql<string | null>`max(${answerFormatVotesTable.updatedAt})`,
    })
    .from(answerFormatVotesTable)
    .groupBy(answerFormatVotesTable.option);
  const counts: Record<FormatOption, number> = { avatar: 0, podcast: 0, text: 0 };
  let total = 0;
  let lastVoteAt: string | null = null;
  for (const r of rows) {
    if ((OPTIONS as readonly string[]).includes(r.option)) {
      counts[r.option as FormatOption] = r.count;
      total += r.count;
      if (r.last && (!lastVoteAt || r.last > lastVoteAt)) lastVoteAt = r.last;
    }
  }
  return { counts, total, lastVoteAt };
}

// Anonymous, self-rate-limited by the one-row-per-voter upsert.
router.post("/format-votes", async (req, res) => {
  try {
    const option = req.body?.option as string | undefined;
    if (!option || !(OPTIONS as readonly string[]).includes(option)) {
      return res
        .status(400)
        .json({ error: "option must be one of: avatar, podcast, text" });
    }
    await db
      .insert(answerFormatVotesTable)
      .values({ option, voterHash: voterHash(req) })
      .onConflictDoUpdate({
        target: answerFormatVotesTable.voterHash,
        set: { option, updatedAt: new Date() },
      });
    const tallies = await loadCounts();
    return res.json({ ok: true, ...tallies });
  } catch (e) {
    req.log.error({ err: e }, "format vote failed");
    return res.status(500).json({ error: "Failed to record vote" });
  }
});

// Lets a returning visitor's widget restore its "you voted X" state across
// devices-free simple reloads. Not sensitive: reveals only the caller's OWN
// prior choice (keyed by their IP hash), never the tallies.
router.get("/format-votes/mine", async (req, res) => {
  try {
    const [row] = await db
      .select({ option: answerFormatVotesTable.option })
      .from(answerFormatVotesTable)
      .where(eq(answerFormatVotesTable.voterHash, voterHash(req)));
    return res.json({ option: row?.option ?? null });
  } catch (e) {
    req.log.error({ err: e }, "format vote lookup failed");
    return res.status(500).json({ error: "Failed to load vote" });
  }
});

router.get("/admin/format-votes", checkAdmin, async (req, res) => {
  try {
    return res.json(await loadCounts());
  } catch (e) {
    req.log.error({ err: e }, "format vote tallies failed");
    return res.status(500).json({ error: "Failed to load votes" });
  }
});

export default router;
