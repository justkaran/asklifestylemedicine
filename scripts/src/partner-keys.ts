/**
 * Admin script: mint, list, and revoke partner API keys for /api/sleep-agent
 * (and any future B2B endpoint that uses partnerKeyMiddleware).
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run partner-keys -- mint \
 *     --partner "Acme Health" --email pm@acme.com \
 *     [--tier pilot|production] \
 *     [--scopes sleep-agent,foo] \
 *     [--rate-per-minute 60] [--rate-per-day 50000] [--concurrent 10] \
 *     [--notes "alpha pilot, sleep only"]
 *
 *   pnpm --filter @workspace/scripts run partner-keys -- list
 *   pnpm --filter @workspace/scripts run partner-keys -- revoke --id 7
 *   pnpm --filter @workspace/scripts run partner-keys -- revoke --prefix plnr_live_a1b2c3d4
 *
 * The raw key is printed exactly ONCE on `mint` and never stored — only
 * its sha256 hash lands in the DB. Copy it from the script output and
 * hand it to the partner over the same channel that requested the pilot.
 */

import { randomBytes, createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  db,
  partnerKeysTable,
  pool,
  type PartnerKey,
} from "@workspace/db";

type Cmd = "mint" | "list" | "revoke";

function parseArgs(argv: string[]): { cmd: Cmd; flags: Record<string, string> } {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = rest[i + 1];
      if (val == null || val.startsWith("--")) {
        flags[key] = "true";
      } else {
        flags[key] = val;
        i++;
      }
    }
  }
  return { cmd: cmd as Cmd, flags };
}

function generateKey(): { raw: string; hash: string; prefix: string } {
  const bytes = randomBytes(24).toString("hex"); // 48 hex chars
  const raw = `plnr_live_${bytes}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 18); // plnr_live_ + first 8 hex
  return { raw, hash, prefix };
}

async function mint(flags: Record<string, string>) {
  const partnerName = flags.partner;
  if (!partnerName) throw new Error("Required: --partner <name>");
  const tier = (flags.tier ?? "pilot") as "pilot" | "production";
  if (tier !== "pilot" && tier !== "production") {
    throw new Error("--tier must be pilot or production");
  }
  const scopes = (flags.scopes ?? "sleep-agent")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ratePerMinute = flags["rate-per-minute"]
    ? Number(flags["rate-per-minute"])
    : 60;
  const ratePerDay = flags["rate-per-day"]
    ? Number(flags["rate-per-day"])
    : 50_000;
  const concurrent = flags.concurrent ? Number(flags.concurrent) : 10;
  for (const [k, v] of [
    ["--rate-per-minute", ratePerMinute],
    ["--rate-per-day", ratePerDay],
    ["--concurrent", concurrent],
  ] as const) {
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error(`${k} must be a positive number`);
    }
  }

  const { raw, hash, prefix } = generateKey();
  const [created] = await db
    .insert(partnerKeysTable)
    .values({
      keyHash: hash,
      keyPrefix: prefix,
      partnerName,
      contactEmail: flags.email ?? null,
      scopes,
      tier,
      ratePerMinute,
      ratePerDay,
      concurrentStreams: concurrent,
      notes: flags.notes ?? null,
    })
    .returning();

  console.log("");
  console.log("─────────────────────────────────────────────────────────");
  console.log("Minted partner key — copy now, this is the ONLY time");
  console.log("the raw key will ever be displayed.");
  console.log("─────────────────────────────────────────────────────────");
  console.log(`  partner : ${created.partnerName}`);
  console.log(`  id      : ${created.id}`);
  console.log(`  prefix  : ${created.keyPrefix}`);
  console.log(`  tier    : ${created.tier}`);
  console.log(`  scopes  : ${created.scopes.join(", ")}`);
  console.log(
    `  limits  : ${created.ratePerMinute}/min · ${created.ratePerDay}/day · ${created.concurrentStreams} concurrent`,
  );
  console.log("");
  console.log(`  X-Palonur-Key: ${raw}`);
  console.log("");
}

async function list() {
  const rows = (await db
    .select()
    .from(partnerKeysTable)
    .orderBy(partnerKeysTable.id)) as PartnerKey[];
  if (rows.length === 0) {
    console.log("(no partner keys)");
    return;
  }
  for (const r of rows) {
    const status = r.revokedAt
      ? `REVOKED ${r.revokedAt.toISOString()}`
      : "active";
    console.log(
      `#${r.id} ${r.keyPrefix}…  ${r.partnerName}  [${r.tier}]  ${r.ratePerMinute}/min ${r.ratePerDay}/day  scopes=${r.scopes.join(",")}  ${status}`,
    );
  }
}

async function revoke(flags: Record<string, string>) {
  const id = flags.id ? Number(flags.id) : null;
  const prefix = flags.prefix ?? null;
  if (!id && !prefix) throw new Error("Required: --id <n> OR --prefix <plnr_…>");

  const where = id
    ? eq(partnerKeysTable.id, id)
    : eq(partnerKeysTable.keyPrefix, prefix!);

  const updated = await db
    .update(partnerKeysTable)
    .set({ revokedAt: sql`NOW()` })
    .where(where)
    .returning();
  if (updated.length === 0) {
    console.log("No matching key (already deleted, or wrong id/prefix).");
    process.exitCode = 1;
    return;
  }
  for (const r of updated) {
    console.log(
      `Revoked #${r.id} ${r.keyPrefix}… (${r.partnerName}) at ${r.revokedAt?.toISOString()}`,
    );
  }
}

async function main() {
  const { cmd, flags } = parseArgs(
    process.argv.slice(2).filter((a) => a !== "--"),
  );
  switch (cmd) {
    case "mint":
      await mint(flags);
      break;
    case "list":
      await list();
      break;
    case "revoke":
      await revoke(flags);
      break;
    default:
      console.log("Usage: partner-keys <mint|list|revoke> [flags]");
      console.log("  mint    --partner <name> [--email] [--tier pilot|production]");
      console.log("          [--scopes sleep-agent,...] [--rate-per-minute N]");
      console.log("          [--rate-per-day N] [--concurrent N] [--notes ...]");
      console.log("  list");
      console.log("  revoke  --id <n> | --prefix <plnr_live_…>");
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
