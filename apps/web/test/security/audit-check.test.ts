// scripts/audit-check.mjs (M1-10): the allowlist policy on synthetic `npm audit --json` reports.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../../scripts/audit-check.mjs", import.meta.url));
const ADVISORY = "https://github.com/advisories/GHSA-test-0000-0000";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(advisories: unknown[], report: unknown, today = "2026-11-04") {
  const dir = mkdtempSync(join(tmpdir(), "carnet-audit-"));
  dirs.push(dir);
  writeFileSync(join(dir, ".audit-allowlist.json"), JSON.stringify({ advisories }));
  writeFileSync(join(dir, "audit.json"), JSON.stringify(report));
  return spawnSync("node", [SCRIPT, "--today", today, "--audit-json", "audit.json"], {
    cwd: dir,
    encoding: "utf8",
  });
}

const high = {
  vulnerabilities: {
    leftpad: { severity: "high", via: [{ url: ADVISORY, title: "x" }] },
    app: { severity: "high", via: ["leftpad"] },
  },
};
const entry = {
  url: ADVISORY,
  package: "leftpad",
  reason: "only reachable from a build script",
  acceptedBy: "owner",
  expires: "2026-11-30",
};

describe("audit-check", () => {
  it("passes a report with only moderate advisories", () => {
    const res = run([], {
      vulnerabilities: { esbuild: { severity: "moderate", via: [{ url: "u" }] } },
    });
    expect(res.status).toBe(0);
  });

  it("fails on a high advisory that is not allowlisted", () => {
    const res = run([], high);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(ADVISORY);
  });

  it("passes when the advisory is allowlisted and unexpired (dependents clear with it)", () => {
    expect(run([entry], high).status).toBe(0);
  });

  it("fails on an expired entry, and on an entry missing a field", () => {
    const expired = run([entry], high, "2026-12-01");
    expect(expired.status).toBe(1);
    expect(expired.stderr).toContain("expired");
    const { reason: _r, ...noReason } = entry;
    const incomplete = run([noReason], { vulnerabilities: {} });
    expect(incomplete.status).toBe(1);
    expect(incomplete.stderr).toContain("lacks reason");
  });
});

describe("the CI workflow runs the scans", () => {
  it("gitleaks, the secret scan and the dependency audit are steps of the check job", async () => {
    const { readFileSync } = await import("node:fs");
    const ci = readFileSync(
      fileURLToPath(new URL("../../../../.github/workflows/ci.yml", import.meta.url)),
      "utf8",
    );
    expect(ci).toMatch(/uses: gitleaks\/gitleaks-action@[0-9a-f]{40}/);
    expect(ci).toContain("run: ./scripts/check-no-secrets.sh");
    expect(ci).toContain("run: node scripts/audit-check.mjs");
  });
});
