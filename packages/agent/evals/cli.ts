// `npm run eval -w packages/agent -- extraction [--replay|--live] [--out file] [--only id]`
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runEval } from "./extraction/run";

const args = process.argv.slice(2);
const suite = args[0];
if (suite !== "extraction") {
  console.error("usage: eval extraction [--replay|--live] [--out file] [--only document-id]");
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
const report = await runEval({
  mode: flag("--live") ? "live" : "replay",
  ...(only ? { only } : {}),
});
const out = value("--out");
const json = `${JSON.stringify(report, null, 2)}\n`;
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
}
const { cases: _cases, per_field: _pf, ...summary } = report;
console.log(JSON.stringify(summary, null, 2));
if (!report.passed) {
  console.error(`EVAL FAILED: ${report.failures.join("; ")}`);
  process.exit(1);
}
