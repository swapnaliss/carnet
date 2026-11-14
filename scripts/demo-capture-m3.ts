// Builds fixtures/replay/m3 from one live run (M3-07). Offline: it reads files, calls nothing.
//
//   npx tsx scripts/demo-capture-m3.ts <export.jsonl> [evidence-dir] [out-dir]
//
//   export.jsonl   the output of scripts/demo-export.sh <since-iso> <file> for the run
//   evidence-dir   default docs/evidence/m3 (run.json and airwallex/*.json written by demo-live.spec.ts)
//   out-dir        default fixtures/replay/m3
//
// Writes: manifest.json (run date, "recording"), webhooks.jsonl (in received order), model-outputs.jsonl
// (agent_steps with tokens and cost), plans.json (plans, actions, states, auto-approvals, obligations),
// attempts.json (execution attempts, approvals, fx quote uses), airwallex/*.json (what the spec read or
// asked of the simulator), run.json. Everything passes through scrub(): secret-named keys are dropped,
// account ids, tokens, bearer values and payee status paths are replaced. Run
// ./scripts/check-no-secrets.sh afterwards; the capture refuses to write a value that looks like a secret.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SECRET_KEY = /signature|secret|token|password|authorization|cookie|api_?key|client_?id/i;
const SECRET_VALUE: [RegExp, string][] = [
  [/acct_[A-Za-z0-9_-]+/g, "acct_SCRUBBED"],
  [/\/status\/[A-Za-z0-9_-]{20,}/g, "/status/TOKEN_SCRUBBED"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer SCRUBBED"],
  [/sk-[A-Za-z0-9_-]{20,}/g, "SK_SCRUBBED"],
];
const FORBIDDEN = [
  /sk-[A-Za-z0-9_-]{32,}/,
  /gh[pousr]_[0-9A-Za-z]{36,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function scrub(value: unknown): unknown {
  if (typeof value === "string")
    return SECRET_VALUE.reduce((v, [re, to]) => v.replace(re, to), value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !SECRET_KEY.test(k))
        .map(([k, v]) => [k, scrub(v)]),
    );
  }
  return value;
}

function write(path: string, value: string): void {
  for (const re of FORBIDDEN)
    if (re.test(value)) throw new Error(`refusing to write ${path}: secret-shaped value`);
  writeFileSync(path, value);
}

type Row = Record<string, unknown>;
function readExport(file: string): { rows: Map<string, Row[]>; summary: unknown } {
  const rows = new Map<string, Row[]>();
  let summary: unknown = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as { table?: string; row?: Row; summary?: unknown };
    if (o.table && o.row) rows.set(o.table, [...(rows.get(o.table) ?? []), o.row]);
    if (o.summary) summary = o.summary;
  }
  return { rows, summary };
}

const when = (r: Row): string =>
  String(r.received_at ?? r.created_at ?? r.at ?? r.updated_at ?? "");
const byTime = (a: Row, b: Row) => when(a).localeCompare(when(b));

function main(): void {
  const [exportFile, evidence = "docs/evidence/m3", out = "fixtures/replay/m3"] =
    process.argv.slice(2);
  if (!exportFile)
    throw new Error("usage: demo-capture-m3.ts <export.jsonl> [evidence-dir] [out-dir]");
  const { rows, summary } = readExport(exportFile);
  const get = (t: string) => (rows.get(t) ?? []).slice().sort(byTime);
  mkdirSync(join(out, "airwallex"), { recursive: true });
  const runJson = join(evidence, "run.json");
  const run = existsSync(runJson) ? (JSON.parse(readFileSync(runJson, "utf8")) as Row) : {};

  const jsonl = (t: string) =>
    `${get(t)
      .map((r) => JSON.stringify(scrub(r)))
      .join("\n")}\n`;
  const json = (tables: string[]) =>
    `${JSON.stringify(Object.fromEntries(tables.map((t) => [t, get(t).map(scrub)])), null, 2)}\n`;

  write(join(out, "webhooks.jsonl"), jsonl("webhook_events"));
  write(
    join(out, "model-outputs.jsonl"),
    `${get("agent_runs")
      .map((r) => JSON.stringify(scrub({ ...r, kind: "run" })))
      .join("\n")}\n${get("agent_steps")
      .map((r) => JSON.stringify(scrub({ ...r, kind: "step" })))
      .join("\n")}\n`,
  );
  write(
    join(out, "plans.json"),
    json([
      "plans",
      "plan_actions",
      "plan_action_states",
      "auto_approvals",
      "obligations",
      "criticality_proposals",
    ]),
  );
  write(
    join(out, "attempts.json"),
    json(["execution_attempts", "approvals", "fx_quote_uses", "audit_log"]),
  );
  write(
    join(out, "rfis.json"),
    json(["rfis", "rfi_questions", "drafts", "draft_answers", "payments"]),
  );

  const copied: string[] = [];
  const awDir = join(evidence, "airwallex");
  if (existsSync(awDir)) {
    for (const f of readdirSync(awDir).filter((n) => n.endsWith(".json"))) {
      write(
        join(out, "airwallex", f),
        `${JSON.stringify(scrub(JSON.parse(readFileSync(join(awDir, f), "utf8"))), null, 2)}\n`,
      );
      copied.push(`airwallex/${f}`);
    }
  }
  if (existsSync(runJson)) {
    write(join(out, "run.json"), `${JSON.stringify(scrub(run), null, 2)}\n`);
    copied.push("run.json");
  }
  const files = [
    "webhooks.jsonl",
    "model-outputs.jsonl",
    "plans.json",
    "attempts.json",
    "rfis.json",
    ...copied,
  ];
  const manifest = {
    kind: "recording",
    label:
      "Recording of a real run against the Airwallex sandbox and the real model; not a simulation.",
    ticket: "M3-07",
    run: (run as { run?: string }).run ?? null,
    run_date: String((run as { started_at?: string }).started_at ?? "").slice(0, 10) || null,
    deployed_version:
      ((run as { steps?: { deployed_version?: string }[] }).steps ?? []).find(
        (s) => s.deployed_version,
      )?.deployed_version ?? null,
    export_summary: summary,
    scrubbed:
      "secret-named keys dropped; account ids, bearer values and payee status paths replaced",
    files,
  };
  write(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`wrote ${files.length + 1} files to ${out}\n`);
}

if (process.argv[1]?.endsWith("demo-capture-m3.ts")) main();
