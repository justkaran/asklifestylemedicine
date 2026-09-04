import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Without an "error" listener, an error on an idle client (e.g. the server
// terminating connections during a restart/failover) is emitted on the pool
// and, unhandled, crashes the whole Node process. Log and let the pool
// discard the broken client and reconnect on the next query.
pool.on("error", (err) => {
  console.error(
    `[db] idle client error (pool will recover on next query): ${err.message}`,
  );
});

// The pool-level listener above only covers IDLE clients — while a client is
// checked out (e.g. inside a drizzle transaction), the pool detaches its own
// listener and a backend termination (Neon restart/suspend, 57P01) emits
// "error" on the bare client. With no listener that is an unhandled "error"
// event and crashes the whole process, even though the in-flight query
// promise already rejected and was handled. Attach a per-client listener at
// connect time so the event is always consumed; the query-level rejection is
// still surfaced to the caller as usual.
pool.on("connect", (client) => {
  client.on("error", (err) => {
    console.error(
      `[db] client connection error (query promise rejects; pool will recover): ${err.message}`,
    );
  });
});

export const db = drizzle(pool, { schema });

let extensionsReady: Promise<void> | null = null;
export function ensureExtensions(): Promise<void> {
  if (!extensionsReady) {
    extensionsReady = pool
      .query("CREATE EXTENSION IF NOT EXISTS vector")
      .then(() => undefined);
  }
  return extensionsReady;
}

export * from "./schema";
export * from "./study-design";
export * from "./source-rigor";
