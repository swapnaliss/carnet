#!/usr/bin/env node
// Bundles the image's Node entry points (M1-06) into dist/runtime/ with esbuild, next to the files
// they read at run time:
//   entry.mjs    PROCESS_MODE switch: web (Next standalone server) | worker
//   release.mjs  preDeploy step: migrations as the migration role
//   setup.mjs    idempotent roles / migrate / seed
//   migrations/  copy of packages/db/migrations;  roles.sql  copy of packages/db/sql/roles.sql
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const out = "dist/runtime";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: {
    entry: "apps/web/src/worker/entry.ts",
    release: "scripts/release.ts",
    setup: "scripts/setup.ts",
  },
  outdir: out,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  // pg's optional native binding is never installed.
  external: ["pg-native"],
  // CommonJS dependencies (pg) call require() inside an ES module bundle.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  legalComments: "none",
  logLevel: "info",
});

cpSync("packages/db/migrations", join(out, "migrations"), { recursive: true });
cpSync("packages/db/sql/roles.sql", join(out, "roles.sql"));
console.log(`build-runtime: wrote ${out}`);
