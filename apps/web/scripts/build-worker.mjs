#!/usr/bin/env node
// Bundles worker mode (src/worker/main.ts) into one ESM file with esbuild. The workspace packages
// (@carnet/*, TypeScript sources with extensionless imports) and their npm dependencies are inlined,
// so the image runs `node worker.mjs` with no loader and no node_modules lookup (BL-01 6575762493).
// Usage: node scripts/build-worker.mjs [outfile]   (default dist/worker.mjs, relative to apps/web)
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = resolve(webRoot, process.argv[2] ?? "dist/worker.mjs");

await build({
  absWorkingDir: webRoot,
  entryPoints: [resolve(webRoot, "src/worker/main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // pg loads its optional native binding only when asked to; it is not installed.
  external: ["pg-native"],
  // CommonJS dependencies (pg) call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __carnetCreateRequire } from 'node:module'; const require = __carnetCreateRequire(import.meta.url);",
  },
  legalComments: "none",
  logLevel: "warning",
});
console.log(`build-worker: wrote ${outfile}`);
