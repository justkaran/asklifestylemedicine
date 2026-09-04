/**
 * Mint sponsored Nightly checkout links — one per pilot member.
 *
 * Each link is a Stripe Checkout session for the hidden $11/mo Nightly price
 * (lookup_key "nightly-sponsored-11"), pre-bound to the MEMBER's email: the
 * server creates (or reuses) the member's consumer account + Stripe customer
 * before Stripe ever sees the request, so whoever pays, the subscription lands
 * on the member's account and their access works the moment they sign in with
 * their email. The sponsor opens each link and pays with their own card —
 * Stripe does not require the card holder to match the customer email.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run mint-sponsored-checkouts             # against production
 *   pnpm --filter @workspace/scripts run mint-sponsored-checkouts -- --base http://localhost:80   # against dev
 *   pnpm --filter @workspace/scripts run mint-sponsored-checkouts -- --dry-run
 *
 * Notes:
 * - Checkout links EXPIRE after 24 hours. Re-run the script any time to mint
 *   fresh ones — it never duplicates subscriptions (paying twice for the same
 *   email WOULD create a second subscription, so pay each member's link once).
 * - After payment the member (not the sponsor) receives the sign-in email —
 *   payment never grants a session to the payer.
 */

const LOOKUP_KEY = "nightly-sponsored-11";
const DEFAULT_BASE = "https://palonur.replit.app";

const MEMBERS: { name: string; email: string }[] = [
  { name: "Max Daub", email: "max@meinunterricht.de" },
  { name: "Stefanie Danner", email: "stefanie.danner@gmail.com" },
  { name: "Patrick Buehler", email: "patrick.buehler.pb2@roche.com" },
  { name: "Rudy Schills", email: "schils@gmail.com" },
  { name: "Seun Ogunkunle", email: "oluseunoss@gmail.com" },
  { name: "Eryna Salamykina", email: "iracyja@gmail.com" },
  { name: "Kai Loeffler", email: "loeffler.kai@web.de" },
  { name: "Jens Ihle", email: "ihle@mittelhessen.org" },
  { name: "Farid Bidardel", email: "farid@codedoor.org" },
  { name: "Nora Schimang", email: "nora@codedoor.org" },
  { name: "Sharujan Premkumar", email: "sharujan@codedoor.org" },
  { name: "Tobias Lang", email: "t.lang@i6m.de" },
];

function parseArgs(): { base: string; dryRun: boolean } {
  const argv = process.argv.slice(2);
  let base = DEFAULT_BASE;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--base") {
      const v = argv[i + 1];
      if (!v) throw new Error("--base requires a URL");
      base = v.replace(/\/+$/, "");
      i += 1;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return { base, dryRun };
}

async function mint(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/billing/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, lookupKey: LOOKUP_KEY }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    url?: string;
    error?: string;
  };
  if (!res.ok || !body.url) {
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return body.url;
}

async function main(): Promise<void> {
  const { base, dryRun } = parseArgs();
  console.log(
    `Minting ${MEMBERS.length} sponsored checkout links against ${base} (price lookup key: ${LOOKUP_KEY})`,
  );
  if (dryRun) {
    for (const m of MEMBERS) console.log(`[dry-run] would mint: ${m.name} <${m.email}>`);
    return;
  }

  const failures: string[] = [];
  const lines: string[] = [];
  for (const m of MEMBERS) {
    try {
      const url = await mint(base, m.email);
      lines.push(`${m.name} <${m.email}>\n  ${url}`);
      console.log(`✓ ${m.name} <${m.email}>`);
    } catch (err) {
      failures.push(`${m.name} <${m.email}>: ${(err as Error).message}`);
      console.error(`✗ ${m.name} <${m.email}>: ${(err as Error).message}`);
    }
  }

  console.log("\n──── Checkout links (expire in 24h — pay each once) ────\n");
  for (const line of lines) console.log(`${line}\n`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} link(s) failed:`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("mint-sponsored-checkouts failed:", err);
  process.exit(1);
});
