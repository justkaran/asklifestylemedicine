import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import fs from "fs";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

// Strip private investor-only static files from the production build so
// they are NOT served on palonur.replit.app. They remain available in
// `pnpm run dev` for editing.
// Every investor deck file MUST be listed here so it is stripped from the prod
// static build — otherwise the gated /api/investor/decks/:slug viewer is moot
// (the same HTML would be directly fetchable as a static file). Keep this in
// lockstep with INVESTOR_DECKS in artifacts/api-server/src/lib/investorDecks.ts.
// NOTE: otl.html is intentionally NOT in this list. Instead of being deleted,
// the OTL brief is MOVED out of dist/public into dist/private below (see
// closeBundle) so express.static can never serve it by any encoded/normalized
// path. The production node server (server/index.mjs) streams it from
// dist/private ONLY to an authenticated OTL dashboard session — see the
// `/otl.html` route there.
const PRIVATE_STATIC_FILES = ["reach.html", "reach-tech.html", "protocol.html", "angels.html", "angels-de.html", "business-plan.html", "investor-deck.html", "investor-scale-100m.html", "investor-tech-moat.html", "investor-how-it-works.html", "investor-user-journeys.html", "ai-newsletter.html", "sample-newsletter.html"];
function stripPrivateStaticFiles() {
  return {
    name: "palonur-strip-private-static",
    apply: "build" as const,
    closeBundle() {
      const outDir = path.resolve(import.meta.dirname, "dist/public");
      for (const name of PRIVATE_STATIC_FILES) {
        const target = path.join(outDir, name);
        if (fs.existsSync(target)) {
          fs.rmSync(target, { force: true });
        }
      }
      // Move the OTL brief OUT of the public root into dist/private so it can
      // never be served by express.static (the security boundary is the file's
      // location, not an exact-route guard in front of a public file). The
      // authenticated /otl.html route in server/index.mjs streams it from here.
      for (const name of ["otl.html", "uit.html"]) {
        const src = path.join(outDir, name);
        if (fs.existsSync(src)) {
          const privDir = path.resolve(import.meta.dirname, "dist/private");
          fs.mkdirSync(privDir, { recursive: true });
          fs.renameSync(src, path.join(privDir, name));
        }
      }
    },
  };
}

const rawPort = process.env.PORT;
const isBuild = process.argv.includes("build");

if (!rawPort && !isBuild) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort ?? 3000);

if (!isBuild && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    stripPrivateStaticFiles(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
