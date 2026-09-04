import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 60000,
    include: ["src/**/*.test.ts"],
    // These are integration suites that all share ONE Postgres. Some files
    // (e.g. newsletter.test.ts) TRUNCATE shared tables in beforeEach, which
    // wipes any concurrently-running file's seeded rows. Run test files
    // serially so cross-file DB state can't race. Tests within a file already
    // run sequentially.
    fileParallelism: false,
    // Purge any stranded `@example.com` faculty accounts left by an interrupted
    // previous run before any suite executes (see globalSetup.ts).
    globalSetup: ["./src/__tests__/globalSetup.ts"],
    alias: [
      // Repo-style ESM imports use ".js" extensions for sibling .ts files.
      // Rewrite them so vitest's resolver can find the actual source file.
      { find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1.ts" },
    ],
  },
});
