/**
 * Eval harness CLI. Runs the seed set against a live /api/sleep-agent
 * endpoint, writes one row per question to `eval_items`, and rolls
 * aggregate auto-metrics onto the parent `eval_runs` row.
 *
 * Pure I/O wrapper around evalSeedSet + evalMetrics. The actual
 * scoring is intentionally simple — it asks the running server to do
 * the work and just records what came back. This means the harness
 * tracks the *real* deployed system, not a re-implementation of it.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run eval -- \
 *     --target http://localhost:80 \
 *     --name "weekly-$(date +%Y-%m-%d)" \
 *     --notes "post citation-guard ship"
 *
 *   pnpm --filter @workspace/scripts run eval -- --dry-run
 *
 * Env:
 *   EVAL_TARGET_URL   — default for --target (e.g. https://palonur.replit.app)
 *   EVAL_BUILD_REF    — git SHA recorded on the run for regression attribution
 *   DATABASE_URL      — required, written to by the harness
 */
import { eq, sql } from "drizzle-orm";
import {
  db,
  pool,
  evalRunsTable,
  evalItemsTable,
} from "@workspace/db";
import { EVAL_SEED_SET, type SeedQuestion } from "./lib/evalSeedSet.js";

interface RunOptions {
  target: string;
  name: string;
  notes: string | null;
  dryRun: boolean;
  limit: number | null;
}

function parseArgs(): RunOptions {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const target =
    get("--target") ??
    process.env.EVAL_TARGET_URL ??
    "http://localhost:80";
  const name =
    get("--name") ??
    `manual-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const notes = get("--notes") ?? null;
  const limitStr = get("--limit");
  const limit = limitStr ? parseInt(limitStr, 10) : null;
  const dryRun = args.includes("--dry-run");
  return { target, name, notes, dryRun, limit };
}

interface SseDoneEvent {
  done?: boolean;
  queryId?: string;
  governedMiss?: boolean;
  citationVerification?: {
    status?: "verified" | "unmatched" | "missing";
  } | null;
}

interface SseRunResult {
  answerText: string;
  governedMiss: boolean;
  citationVerification: "verified" | "unmatched" | "missing" | null;
  latencyMs: number;
  error: string | null;
}

/**
 * POSTs the question to /api/sleep-agent, accumulates the streamed SSE
 * content chunks into a single answer body, and returns the final
 * `done` frame metadata. Never throws on transport errors — captures
 * them on the returned `error` field so the harness can record a row
 * even for crashed items.
 */
async function runOneQuestion(
  target: string,
  question: string,
): Promise<SseRunResult> {
  const started = Date.now();
  const out: SseRunResult = {
    answerText: "",
    governedMiss: false,
    citationVerification: null,
    latencyMs: 0,
    error: null,
  };
  try {
    const res = await fetch(`${target.replace(/\/$/, "")}/api/sleep-agent`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ message: question }),
    });
    if (!res.ok || !res.body) {
      out.error = `HTTP ${res.status} ${res.statusText}`;
      out.latencyMs = Date.now() - started;
      return out;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data: ")) continue;
        try {
          const payload = JSON.parse(line.slice(6)) as
            | { content?: string }
            | SseDoneEvent
            | { error?: string };
          if ("content" in payload && typeof payload.content === "string") {
            out.answerText += payload.content;
          } else if ("error" in payload && payload.error) {
            out.error = String(payload.error);
          } else if ("done" in payload && payload.done) {
            const d = payload as SseDoneEvent;
            out.governedMiss = !!d.governedMiss;
            out.citationVerification = d.citationVerification?.status ?? null;
          }
        } catch {
          // ignore non-JSON SSE lines
        }
      }
    }
  } catch (e) {
    out.error = String((e as Error).message ?? e);
  }
  out.latencyMs = Date.now() - started;
  return out;
}

function classifyAnswer(answerText: string): {
  wasUncovered: boolean;
  wasRefused: boolean;
} {
  const trimmed = answerText.trim();
  return {
    wasUncovered: trimmed.startsWith("UNCOVERED:"),
    wasRefused: trimmed.startsWith("REFUSE:"),
  };
}

function fmtRate(r: number | null): string {
  if (r === null) return "n/a";
  return `${(r * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const seed: SeedQuestion[] = opts.limit
    ? EVAL_SEED_SET.slice(0, opts.limit)
    : EVAL_SEED_SET;

  console.log(
    `eval-harness: ${seed.length} questions → ${opts.target} (${opts.dryRun ? "DRY RUN" : "live"})`,
  );

  let runId = 0;
  if (!opts.dryRun) {
    const [created] = await db
      .insert(evalRunsTable)
      .values({
        name: opts.name,
        notes: opts.notes,
        buildRef: process.env.EVAL_BUILD_REF ?? null,
        targetUrl: opts.target,
        totalItems: seed.length,
      })
      .returning({ id: evalRunsTable.id });
    runId = created!.id;
    console.log(`eval-harness: run #${runId} "${opts.name}" started`);
  }

  for (let i = 0; i < seed.length; i++) {
    const q = seed[i]!;
    process.stdout.write(`  [${i + 1}/${seed.length}] ${q.expected.padEnd(9)} ${q.question.slice(0, 60)}… `);
    const r = await runOneQuestion(opts.target, q.question);
    const cls = classifyAnswer(r.answerText);
    const governedUsed = !r.governedMiss;

    if (!opts.dryRun) {
      await db.insert(evalItemsTable).values({
        runId,
        seedIndex: i,
        question: q.question,
        expectedOutcome: q.expected,
        category: q.category,
        answerText: r.answerText,
        citationVerification: r.citationVerification,
        wasUncovered: cls.wasUncovered,
        wasRefused: cls.wasRefused,
        governedUsed,
        topScore: 0, // not exposed in SSE; available via /api/coverage later
        retrievedSourceIds: [],
        retrievedInterpretationIds: [],
        latencyMs: r.latencyMs,
        runError: r.error,
      });
      await db
        .update(evalRunsTable)
        .set({ completedItems: sql`${evalRunsTable.completedItems} + 1` })
        .where(eq(evalRunsTable.id, runId));
    }

    const tag = r.error
      ? `ERROR(${r.error.slice(0, 40)})`
      : cls.wasRefused
        ? "refused"
        : cls.wasUncovered
          ? "uncovered"
          : (r.citationVerification ?? (governedUsed ? "no-cite" : "legacy"));
    console.log(`${tag} ${r.latencyMs}ms`);
  }

  // Compute aggregate metrics by SQL-aggregating items directly from
  // the same DB we just wrote to. The server exposes a "recompute"
  // endpoint that does the same thing for UI refresh — we go straight
  // to the DB here to avoid requiring an authenticated faculty session
  // on the CLI.
  if (!opts.dryRun) {
    const { rows } = await pool.query<{
      expected_outcome: "covered" | "uncovered" | "refuse";
      was_refused: boolean;
      was_uncovered: boolean;
      governed_used: boolean;
      citation_verification: string | null;
      latency_ms: number;
    }>(
      `SELECT expected_outcome, was_refused, was_uncovered, governed_used,
              citation_verification, latency_ms
         FROM eval_items
        WHERE run_id = $1`,
      [runId],
    );
    const metrics = computeRawMetrics(rows);
    await pool.query(
      `UPDATE eval_runs
          SET citation_verified_rate = $1,
              citation_unmatched_rate = $2,
              citation_missing_rate = $3,
              coverage_rate = $4,
              refusal_compliance_rate = $5,
              uncovered_honesty_rate = $6,
              median_latency_ms = $7,
              completed_at = NOW()
        WHERE id = $8`,
      [
        metrics.citationVerifiedRate,
        metrics.citationUnmatchedRate,
        metrics.citationMissingRate,
        metrics.coverageRate,
        metrics.refusalComplianceRate,
        metrics.uncoveredHonestyRate,
        metrics.medianLatencyMs,
        runId,
      ],
    );
    console.log("\n=== Aggregate metrics ===");
    console.log(`  total items:               ${metrics.totalItems}`);
    console.log(`  citation verified rate:    ${fmtRate(metrics.citationVerifiedRate)}`);
    console.log(`  citation unmatched rate:   ${fmtRate(metrics.citationUnmatchedRate)}`);
    console.log(`  citation missing rate:     ${fmtRate(metrics.citationMissingRate)}`);
    console.log(`  coverage rate (covered):   ${fmtRate(metrics.coverageRate)}`);
    console.log(`  refusal compliance:        ${fmtRate(metrics.refusalComplianceRate)}`);
    console.log(`  uncovered honesty rate:    ${fmtRate(metrics.uncoveredHonestyRate)}`);
    console.log(`  median latency ms:         ${metrics.medianLatencyMs ?? "n/a"}`);
    console.log(`\nrun #${runId} done. Grade at /faculty/evals/${runId}`);
  } else {
    console.log("\n(dry run — no rows written, no metrics computed)");
  }

  await pool.end();
}

/**
 * Inline copy of api-server/src/lib/evalMetrics.ts. Kept here so the
 * script has no cross-workspace TS dependency on api-server (api-server
 * is a leaf app, not a lib). The canonical implementation is the one
 * on the server — unit-tested in evalMetrics.test.ts. If you change
 * the math, update both.
 */
interface RawRow {
  expected_outcome: "covered" | "uncovered" | "refuse";
  was_refused: boolean;
  was_uncovered: boolean;
  governed_used: boolean;
  citation_verification: string | null;
  latency_ms: number;
}
function safeRate(n: number, d: number): number | null {
  return d === 0 ? null : n / d;
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[m - 1]! + s[m]!) / 2) : s[m]!;
}
function computeRawMetrics(rows: RawRow[]) {
  const covered = rows.filter((r) => r.expected_outcome === "covered");
  const uncovered = rows.filter((r) => r.expected_outcome === "uncovered");
  const refuse = rows.filter((r) => r.expected_outcome === "refuse");
  const verifiable = rows.filter((r) => r.citation_verification !== null);
  return {
    totalItems: rows.length,
    citationVerifiedRate: safeRate(
      verifiable.filter((r) => r.citation_verification === "verified").length,
      verifiable.length,
    ),
    citationUnmatchedRate: safeRate(
      verifiable.filter((r) => r.citation_verification === "unmatched").length,
      verifiable.length,
    ),
    citationMissingRate: safeRate(
      verifiable.filter((r) => r.citation_verification === "missing").length,
      verifiable.length,
    ),
    coverageRate: safeRate(
      covered.filter((r) => !r.was_uncovered).length,
      covered.length,
    ),
    refusalComplianceRate: safeRate(
      refuse.filter((r) => r.was_refused).length,
      refuse.length,
    ),
    uncoveredHonestyRate: safeRate(
      uncovered.filter((r) => r.was_uncovered || !r.governed_used).length,
      uncovered.length,
    ),
    medianLatencyMs: median(rows.map((r) => r.latency_ms).filter((n) => n > 0)),
  };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
