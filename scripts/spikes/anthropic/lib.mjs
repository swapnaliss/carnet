// M0-06 Anthropic spike helpers. Key from the environment only; nothing secret is printed or recorded.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..", "..", "..");
export const FIXTURES = join(ROOT, "fixtures", "anthropic");
export const DATASET = join(ROOT, "fixtures", "dataset");
mkdirSync(FIXTURES, { recursive: true });

// PROJECT.md §4 prices, USD per million tokens. Above 100k prompt tokens the price is 5x (not reached here).
export const PRICES = {
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
};
export const CAP = Number(process.env.MODEL_PER_RUN_CAP_USD ?? 2);
let spent = 0;
export const spend = () => spent;

export function cost(model, usage) {
  const p = PRICES[model];
  const input =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
  const mult = input > 100_000 ? 5 : 1;
  return ((input * p.in + (usage.output_tokens ?? 0) * p.out) / 1e6) * mult;
}

export function charge(model, usage) {
  const c = cost(model, usage);
  spent += c;
  if (spent > CAP) throw new Error(`per-run cap exceeded: $${spent.toFixed(4)} > $${CAP}`);
  return c;
}

// messages.parse() returns a plain promise (no withResponse), so a fetch wrapper keeps each response's headers.
export const seen = { last: null, attempts: [] };
export const tracingFetch = async (url, init) => {
  const r = await fetch(url, init);
  seen.last = r;
  seen.attempts.push({
    at: new Date().toISOString(),
    status: r.status,
    retry_after: r.headers.get("retry-after"),
  });
  return r;
};
export const client = new Anthropic({ maxRetries: 2, timeout: 120_000, fetch: tracingFetch });

// Headers worth keeping. Organisation ids and anything else are dropped.
export function keepHeaders(h) {
  const out = {};
  for (const [k, v] of h.entries()) {
    if (k.startsWith("anthropic-ratelimit-") || k === "request-id" || k === "retry-after")
      out[k] = v;
  }
  return out;
}

export function record(name, data) {
  const s = JSON.stringify(data, null, 2);
  if (process.env.ANTHROPIC_API_KEY && s.includes(process.env.ANTHROPIC_API_KEY))
    throw new Error("refusing to record a key");
  writeFileSync(join(FIXTURES, `${name}.json`), `${s}\n`);
}

export const pdfBase64 = (file) => readFileSync(join(DATASET, file)).toString("base64");
export const groundTruth = () =>
  JSON.parse(readFileSync(join(DATASET, "ground-truth.json"), "utf8"));

// Strip the message down to what a test replays: no organisation ids.
export const msgView = (m) => ({
  id: m.id,
  model: m.model,
  stop_reason: m.stop_reason,
  stop_details: m.stop_details ?? undefined,
  usage: m.usage,
  content: m.content,
  parsed_output: m.parsed_output,
});
