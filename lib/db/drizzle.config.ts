import { defineConfig } from "drizzle-kit";
import path from "path";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the legacy broad-schema push workflow");
}

export default defineConfig({
  // Legacy broad schema configuration retained for existing Replit/PALONUR
  // push workflows. Stanford's bounded, checked-in migration history uses
  // drizzle.stanford.config.ts instead.
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
