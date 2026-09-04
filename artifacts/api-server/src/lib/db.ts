import { Pool } from "pg";
import { logger } from "./logger";

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });

// Without an "error" listener, an error on an idle client (e.g. Postgres
// terminating connections during a restart) crashes the whole process.
pool.on("error", (err) => {
  logger.warn({ err }, "pg pool idle client error; pool will recover");
});

// The idle listener does NOT cover checked-out clients: while a client is in
// use the pool detaches its own handler, so a backend termination (57P01)
// emits "error" on the bare client and, unhandled, crashes the process.
// Attach a listener to every client at connect time.
pool.on("connect", (client) => {
  client.on("error", (err) => {
    logger.warn({ err }, "pg client connection error; pool will recover");
  });
});

export default pool;
