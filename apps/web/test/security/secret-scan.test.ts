// Secret scan canary (M1-10 AC 9): scripts/check-no-secrets.sh exits non-zero when a secret-shaped
// string is staged. The string is built at run time (never a literal in this file) and staged only in a
// throwaway git repository under $TMPDIR that holds a copy of the script.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../../scripts/check-no-secrets.sh", import.meta.url));
const dirs: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "carnet-secret-scan-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  mkdirSync(join(dir, "scripts"));
  copyFileSync(SCRIPT, join(dir, "scripts/check-no-secrets.sh"));
  writeFileSync(join(dir, "README.md"), "clean\n");
  git("add", "-A");
  return dir;
}

function scan(dir: string) {
  return spawnSync("bash", ["scripts/check-no-secrets.sh"], { cwd: dir, encoding: "utf8" });
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("secret-scan canary", () => {
  it("a clean staged tree passes", () => {
    const res = scan(tempRepo());
    expect(res.stdout).toContain("check-no-secrets: ok");
    expect(res.status).toBe(0);
  });

  it("a staged secret-shaped string fails, and the value is never printed", () => {
    const dir = tempRepo();
    // `sk-` followed by 40 characters: the generic provider-key pattern. Assembled here, not a literal.
    const fake = ["s", "k", "-"].join("") + "Q7x".repeat(14).slice(0, 40);
    writeFileSync(join(dir, "leak.ts"), `export const key = "${fake}";\n`);
    execFileSync("git", ["add", "leak.ts"], { cwd: dir });
    const res = scan(dir);
    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain("SECRET-SHAPED LITERAL");
    expect(res.stdout).toContain("leak.ts:1");
    expect(res.stdout + res.stderr).not.toContain(fake);
  });

  it("a staged .env file fails", () => {
    const dir = tempRepo();
    writeFileSync(join(dir, ".env"), "NOTHING=here\n");
    execFileSync("git", ["add", "-f", ".env"], { cwd: dir });
    const res = scan(dir);
    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain("FORBIDDEN FILE");
  });
});
