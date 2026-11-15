// `npm run eval -- --mode replay|live [--limit n] [--out file]`: the M4-03 suite (suite/run.ts).
// `npm run eval -w packages/agent -- extraction [--replay|--live] [--out file] [--only id]`: one M2 eval.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runDraftingEval } from "./drafting/run";
import { runEval } from "./extraction/run";
import { EVIDENCE_PATH, renderMarkdown, runSuite } from "./suite/run";
import { runMutationEval } from "./verifier-mutation/run";

const args = process.argv.slice(2);
const suite = args[0];
if (suite === undefined || suite.startsWith("--")) {
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const mode = opt("--mode") ?? "replay";
  if (mode !== "replay" && mode !== "live") {
    console.error("usage: eval --mode replay|live [--limit n] [--out file]");
    process.exit(2);
  }
  const limit = opt("--limit") ? Number(opt("--limit")) : undefined;
  const capRaw = process.env.EVAL_SPEND_CAP_USD;
  const capUsd = capRaw === undefined || capRaw === "" ? undefined : Number(capRaw);
  if (capUsd !== undefined && !(capUsd >= 0)) {
    console.error(`EVAL_SPEND_CAP_USD must be a non-negative number, got "${capRaw}"`);
    process.exit(2);
  }
  const out = opt("--out") ?? EVIDENCE_PATH;
  try {
    const report = await runSuite({
      mode,
      ...(limit ? { limit } : {}),
      ...(capUsd !== undefined ? { capUsd } : {}),
      weakenVerifier: process.env.EVAL_WEAKEN_VERIFIER === "1",
    });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderMarkdown(report));
    const summary = renderMarkdown(report).split("## Summary")[1]?.split("## Failures")[0] ?? "";
    console.log(summary.trim());
    console.log(`results: ${out}`);
    if (!report.passed) {
      console.error(`EVAL FAILED:\n${report.failures.map((f) => `  - ${f}`).join("\n")}`);
      process.exit(1);
    }
    process.exit(0);
  } catch (error) {
    console.error(`EVAL ABORTED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
if (suite !== "extraction" && suite !== "drafting" && suite !== "verifier-mutation") {
  console.error(
    "usage: eval extraction|drafting|verifier-mutation [--replay|--live] [--out file] [--only id]",
  );
  process.exit(2);
}
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (flag("--live") && flag("--replay")) {
  console.error("choose --live or --replay");
  process.exit(2);
}
const only = value("--only");
const mode = flag("--live") ? "live" : "replay";
const report =
  suite === "drafting"
    ? await runDraftingEval({ mode, ...(only ? { only } : {}) })
    : suite === "verifier-mutation"
      ? await runMutationEval()
      : await runEval({ mode, ...(only ? { only } : {}) });
const out = value("--out");
const json = `${JSON.stringify(report, null, 2)}\n`;
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
}
const {
  cases: _cases,
  per_field: _pf,
  results: _results,
  ...summary
} = report as typeof report & {
  cases?: unknown;
  per_field?: unknown;
  results?: unknown;
};
console.log(JSON.stringify(summary, null, 2));
if (!report.passed) {
  console.error(`EVAL FAILED: ${report.failures.join("; ")}`);
  process.exit(1);
}
