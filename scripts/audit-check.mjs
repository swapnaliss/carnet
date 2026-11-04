#!/usr/bin/env node
// CI dependency audit (M1-10): `npm audit --omit=dev --audit-level=high`, minus the advisories accepted
// in .audit-allowlist.json. Fails on any high or critical advisory that is not allowlisted, on an
// allowlist entry that has expired or lacks a field, and when npm audit itself cannot run.
// Usage: node scripts/audit-check.mjs [--today YYYY-MM-DD] [--audit-json <file>]   (flags are for tests)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const today = flag("--today") ?? new Date().toISOString().slice(0, 10);
const REQUIRED = ["url", "package", "reason", "acceptedBy", "expires"];

const allowlist = JSON.parse(readFileSync(".audit-allowlist.json", "utf8")).advisories ?? [];
let failed = false;
for (const entry of allowlist) {
  const missing = REQUIRED.filter((k) => typeof entry[k] !== "string" || entry[k] === "");
  if (missing.length > 0) {
    console.error(`audit-check: allowlist entry ${entry.url ?? "?"} lacks ${missing.join(", ")}`);
    failed = true;
  } else if (entry.expires < today) {
    console.error(`audit-check: allowlist entry ${entry.url} expired on ${entry.expires}`);
    failed = true;
  }
}
const accepted = new Set(allowlist.filter((e) => e.expires >= today).map((e) => e.url));

let report;
const file = flag("--audit-json");
if (file) {
  report = JSON.parse(readFileSync(file, "utf8"));
} else {
  const run = spawnSync("npm", ["audit", "--omit=dev", "--audit-level=high", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    report = JSON.parse(run.stdout);
  } catch {
    console.error("audit-check: npm audit produced no JSON report");
    console.error(run.stderr);
    process.exit(1);
  }
  if (report.error) {
    console.error(`audit-check: npm audit failed: ${report.error.summary ?? "unknown error"}`);
    process.exit(1);
  }
}

const blocking = [];
for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  if (vuln.severity !== "high" && vuln.severity !== "critical") continue;
  // `via` holds advisory objects (with a url) or names of vulnerable dependencies.
  const urls = (vuln.via ?? []).filter((v) => typeof v === "object").map((v) => v.url);
  const open = urls.filter((u) => !accepted.has(u));
  if (urls.length === 0 || open.length > 0) {
    blocking.push(
      `${name} (${vuln.severity}): ${open.join(", ") || "via a vulnerable dependency"}`,
    );
  }
}
// A package flagged only through a vulnerable dependency is cleared when that dependency is.
const direct = blocking.filter((b) => !b.endsWith("via a vulnerable dependency"));
const unresolved = direct.length > 0 ? blocking : [];

for (const b of unresolved) console.error(`audit-check: ${b}`);
if (failed || unresolved.length > 0) {
  console.error("audit-check: FAIL");
  process.exit(1);
}
console.log(
  `audit-check: ok (no unaccepted high or critical advisories; ${accepted.size} accepted entr${accepted.size === 1 ? "y" : "ies"})`,
);
