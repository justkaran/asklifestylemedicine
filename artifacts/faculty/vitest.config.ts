import { defineConfig } from "vitest/config";
import path from "path";

// Standalone test config — does NOT import vite.config.ts, which throws unless
// PORT/BASE_PATH are set (they only exist inside the dev workflow). Component
// tests run under jsdom with esbuild's automatic JSX transform, so no
// @vitejs/plugin-react / Fast Refresh is needed.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/__tests__/setup.ts"],
  },
});
