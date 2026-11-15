// M4-03: the suite's own guarantees. The judge can never override a failed code assertion; the mutation
// set is reproducible from its seed and a weakened verifier lets mutants through (so the suite fails and
// names them); the README check fails on a wrong number; the CI trigger's dry run holds.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { combineVerdict, judgePasses, RUBRIC_PATH } from "../evals/suite/judge";
import { DEFAULT_SEED, prng, runMutationSet } from "../evals/suite/mutation";
import "./replay-env";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const best = { fluency: 5, helpfulness: 5, rationale: "excellent" };
const poor = { fluency: 2, helpfulness: 2, rationale: "hard to read" };

describe("judge: code assertions first, the judge can only add a failure", () => {
  it("a failed code assertion stays failed whatever the judge scores", () => {
    expect(combineVerdict(false, best)).toEqual({ passed: false, by: "code" });
    expect(combineVerdict(false, null)).toEqual({ passed: false, by: "code" });
  });
  it("a passed code assertion can still fail on the judge, and passes without one", () => {
    expect(combineVerdict(true, poor)).toEqual({ passed: false, by: "code+judge" });
    expect(combineVerdict(true, best)).toEqual({ passed: true, by: "code+judge" });
    expect(combineVerdict(true, null)).toEqual({ passed: true, by: "code" });
  });
  it("the threshold follows the rubric (each >= 3, mean >= 3.5)", () => {
    expect(judgePasses({ fluency: 3, helpfulness: 4, rationale: "" })).toBe(true);
    expect(judgePasses({ fluency: 3, helpfulness: 3, rationale: "" })).toBe(false);
    expect(judgePasses({ fluency: 2, helpfulness: 5, rationale: "" })).toBe(false);
    expect(readFileSync(RUBRIC_PATH, "utf8")).toContain("rubric@1");
  });
});

describe("mutation set", () => {
  it("the PRNG is deterministic per seed", () => {
    const a = prng(DEFAULT_SEED);
    const b = prng(DEFAULT_SEED);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
  it("is reproducible, spans numbers, dates and names, and is 100% rejected", async () => {
    const one = await runMutationSet({});
    const two = await runMutationSet({});
    expect(one.mutants).toBe(two.mutants);
    expect(one.mutants).toBeGreaterThanOrEqual(100);
    expect(one.rejected).toBe(one.mutants);
    for (const c of [
      "wrong_amount",
      "digit_off_by_one",
      "shifted_date",
      "swapped_date_parts",
      "lookalike_name",
      "swapped_name",
      "currency_swap",
    ]) {
      expect(one.per_class[c]?.mutants, c).toBeGreaterThan(0);
    }
  });
  it("a weakened verifier lets mutants survive, and each survivor is named with its mutation", async () => {
    const weak = await runMutationSet({ weakened: true });
    expect(weak.survivors.length).toBeGreaterThan(0);
    expect(weak.survivors[0]).toMatchObject({
      class: expect.any(String),
      variant: expect.any(String),
    });
  });
});

describe("scripts/check-readme-numbers.py", () => {
  const run = (readme: string) => {
    const dir = mkdtempSync(join(tmpdir(), "readme-check-"));
    const path = join(dir, "README.md");
    writeFileSync(path, readme);
    return spawnSync("python3", [`${ROOT}scripts/check-readme-numbers.py`, "--readme", path], {
      encoding: "utf8",
    });
  };
  const readme = readFileSync(`${ROOT}README.md`, "utf8");
  it("passes on the README as committed", () => {
    expect(run(readme).status).toBe(0);
  });
  it("fails when a number is edited to a wrong value", () => {
    const evidence = readFileSync(`${ROOT}docs/evidence/evals.md`, "utf8");
    const cases = evidence.match(/^- cases: (\d+)/m)?.[1];
    expect(cases).toBeDefined();
    const bad = run(readme.replace(`cases: ${cases} `, `cases: ${Number(cases) + 1} `));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("cases");
    expect(
      run(readme.replace("mutation rejection: 100%", "mutation rejection: 99.9%")).status,
    ).toBe(1);
  });
});

describe("scripts/eval-ci-trigger.py", () => {
  it("self-test: the paths filter and the fork rule hold", () => {
    const out = execFileSync("python3", [`${ROOT}scripts/eval-ci-trigger.py`, "--self-test"], {
      encoding: "utf8",
    });
    expect(out).toContain("self-test: PASS");
  });
  it("a prompt change triggers live, a README change does not", () => {
    const run = (f: string) =>
      execFileSync("python3", [`${ROOT}scripts/eval-ci-trigger.py`, "--files", f], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: "" },
      });
    expect(run("packages/agent/src/drafting/prompts/draft.ts")).toContain("live=true");
    expect(run("README.md")).toContain("live=false");
  });
});
