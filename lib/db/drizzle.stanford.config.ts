import { defineConfig } from "drizzle-kit";
import path from "path";

/**
 * Credential-free by design: this config only generates and checks the
 * reviewed Stanford/SLM migration history. Applying it uses the explicit
 * --database-url guarded runner, never an application DATABASE_URL.
 */
export default defineConfig({
  schema: path.join(__dirname, "./src/schema/slm.ts"),
  // drizzle-kit check resolves snapshot paths relative to its working
  // directory, so this must remain relative.
  out: "./migrations",
  dialect: "postgresql",
  strict: true,
  verbose: true,
});