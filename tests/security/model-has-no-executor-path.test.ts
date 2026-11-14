// STRIDE "Elevation of privilege: Prompt-injected plan action" (architecture §8): whatever a hostile
// model returns, there is no code path from model output to a money action. Structural proof by
// import scan: the model package reaches neither the database, Airwallex nor the executors, and the
// worker handlers that run the model never import an executor or consume an approval.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "node_modules") return [];
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

const importsOf = (file: string): string[] =>
  [...readFileSync(file, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] as string);

describe("the model package has no path to money or storage", () => {
  const files = sources(join(ROOT, "packages/agent/src"));
  it("scans the package", () => expect(files.length).toBeGreaterThan(10));

  it.each(["@carnet/db", "@carnet/airwallex"])("no file imports %s", (pkg) => {
    const offenders = files.filter((f) => importsOf(f).some((i) => i === pkg || i.startsWith(`${pkg}/`)));
    expect(offenders).toEqual([]);
  });

  it("no file imports an executor, an approval consumer or a plan action", () => {
    const offenders = files.filter((f) =>
      importsOf(f).some((i) => /executors?|approvals?|plan-actions?|action-states/.test(i)),
    );
    expect(offenders).toEqual([]);
  });
});

describe("worker handlers that run the model never execute money", () => {
  const modelHandlers = ["draft.ts", "extract.ts", "criticality.ts", "answer-memory.ts"];
  const dir = join(ROOT, "apps/web/src/worker/handlers");

  it.each(modelHandlers)("%s imports no executor and no approval consumer", (name) => {
    const src = readFileSync(join(dir, name), "utf8");
    expect(src).not.toMatch(/executeConversion|executePayout|consumeApproval|createTransfer|\/executors/);
  });

  it("only the owner-approved handlers import the executors", () => {
    const importers = readdirSync(dir).filter((n) =>
      /executeConversion|executePayout|consumeApproval/.test(readFileSync(join(dir, n), "utf8")),
    );
    expect(importers.sort()).toEqual(["execute.ts", "rfi-respond.ts"]);
  });
});
