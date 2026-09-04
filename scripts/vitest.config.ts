import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    alias: [
      // Repo-style ESM imports use ".js" extensions for sibling .ts files.
      // Rewrite them so vitest's resolver can find the actual source file.
      { find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1.ts" },
    ],
  },
});
