import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

// One-off script runner: bundles src/scripts/<name>.ts with the same esbuild
// setup as the server build (see build.mjs), then executes it with node.
// Usage: node run-script.mjs <scriptName> [args...]

globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const name = process.argv[2];
if (!name) {
  console.error("usage: node run-script.mjs <scriptName> [args...]");
  process.exit(1);
}

const entry = path.resolve(artifactDir, `src/scripts/${name}.ts`);
const outDir = path.resolve(artifactDir, "dist-scripts");

await esbuild({
  entryPoints: [entry],
  platform: "node",
  bundle: true,
  format: "esm",
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  logLevel: "warning",
  external: [
    "*.node",
    "stripe-replit-sync",
    "@x402/fetch",
    "@x402/*",
    "pdf-parse",
    "sharp",
    "pg-native",
    "onnxruntime-node",
    "@huggingface/transformers",
    "@google-cloud/*",
  ],
  sourcemap: "linked",
  plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
  banner: {
    js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
  },
});

const child = spawn(
  process.execPath,
  ["--enable-source-maps", path.resolve(outDir, `${name}.mjs`), ...process.argv.slice(3)],
  { stdio: "inherit", cwd: artifactDir },
);
// Forward termination signals so killing this runner (timeout, Ctrl-C,
// session teardown) also stops the script — otherwise the child keeps
// running detached and a restarted runner races it against the same DB.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
child.on("exit", (code) => process.exit(code ?? 1));
