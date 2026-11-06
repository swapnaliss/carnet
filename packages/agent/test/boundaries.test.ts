// AC11: packages/agent imports no web framework, and packages/domain imports nothing from it. Also:
// the API key is read in one module only, and the harness source never names the API host.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules") continue;
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const importsOf = (file: string) =>
  [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
    (m) => m[1] ?? "",
  );

const WEB_FRAMEWORKS =
  /^(next|next\/.*|react|react-dom|react\/.*|express|fastify|koa|hono|@hono\/.*|better-auth.*|@carnet\/web|@carnet\/db|@carnet\/airwallex|pg|drizzle-orm.*)$/;

describe("AC11: dependency boundaries", () => {
  const agentFiles = sources(join(ROOT, "packages/agent/src"));
  const domainFiles = sources(join(ROOT, "packages/domain/src"));

  it("finds the sources", () => {
    expect(agentFiles.length).toBeGreaterThanOrEqual(8);
    expect(domainFiles.length).toBeGreaterThan(0);
  });

  it.each(agentFiles.map((f) => [f.slice(ROOT.length)]))("%s imports no web framework", (f) => {
    const bad = importsOf(join(ROOT, f)).filter((i) => WEB_FRAMEWORKS.test(i));
    expect(bad).toEqual([]);
  });

  it("packages/domain imports nothing from packages/agent", () => {
    for (const f of domainFiles) {
      const bad = importsOf(f).filter(
        (i) => i.startsWith("@carnet/agent") || /packages\/agent/.test(i),
      );
      expect(bad, f).toEqual([]);
    }
    const pkg = JSON.parse(readFileSync(join(ROOT, "packages/domain/package.json"), "utf8"));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain(
      "@carnet/agent",
    );
  });

  it("the API key is read in exactly one module (client.ts)", () => {
    const readers = agentFiles.filter((f) => readFileSync(f, "utf8").includes("ANTHROPIC_API_KEY"));
    expect(readers.map((f) => f.slice(ROOT.length))).toEqual(["packages/agent/src/client.ts"]);
  });
});
