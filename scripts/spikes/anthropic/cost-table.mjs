// Print the per-document and per-draft token/cost table from the recorded fixtures (markdown).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "fixtures/anthropic";
const rows = [];
for (const f of readdirSync(dir)
  .filter((x) => /^(extract|draft)-.*\.json$/.test(x))
  .sort()) {
  const fx = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const u = fx.response.usage;
  const unit = fx.kind === "extraction" ? "per document" : "per draft";
  rows.push(
    `| ${unit} | ${f.replace(".json", "")} | ${fx.request.model} | ${u.input_tokens} | ${u.output_tokens} | ${fx.response.stop_reason} | $${fx.cost_usd.toFixed(6)} | ${fx.latency_ms} |`,
  );
}
console.log(
  "| Unit | Call | Model | Input tokens | Output tokens | stop_reason | Cost | Latency ms |",
);
console.log("|---|---|---|---|---|---|---|---|");
console.log(rows.join("\n"));
