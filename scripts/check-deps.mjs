#!/usr/bin/env node
// Dependency direction (ADR 0001): domain imports no other workspace package; db, airwallex and agent
// may import domain only; apps/web may import any. Checks package.json and source imports.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const allowed = {
  "packages/domain": [],
  "packages/db": ["@carnet/domain"],
  "packages/airwallex": ["@carnet/domain"],
  "packages/agent": ["@carnet/domain"],
  "apps/web": ["@carnet/domain", "@carnet/db", "@carnet/airwallex", "@carnet/agent"],
};

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(name)) yield p;
  }
}

const errors = [];
for (const [dir, ok] of Object.entries(allowed)) {
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      if (dep.startsWith("@carnet/") && !ok.includes(dep))
        errors.push(`${pkgPath}: may not depend on ${dep}`);
    }
  }
  for (const file of existsSync(dir) ? walk(dir) : []) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](@carnet\/[^"'/]+)/g)) {
      if (!ok.includes(m[1]) && m[1] !== `@carnet/${dir.split("/")[1]}`) {
        errors.push(`${file}: imports ${m[1]} (allowed: ${ok.join(", ") || "none"})`);
      }
    }
  }
}
if (errors.length) {
  console.error(`check-deps: dependency direction violated (ADR 0001)\n${errors.join("\n")}`);
  process.exit(1);
}
console.log("check-deps: ok");
