// Verify every extracted quote against the PDF text layer with unpdf (whitespace normalised only).
// Usage: node verify-quotes.mjs fixtures/anthropic [--mutate]   (reads extract-*.json)
// --mutate changes one character of every quote, to show that mismatches are reported as such.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";

const dir = process.argv[2] ?? "fixtures/anthropic";
const mutate = process.argv.includes("--mutate");
const DATASET = join(dir, "..", "dataset");
const norm = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();

export async function pages(file) {
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(join(DATASET, file))));
  const r = await extractText(pdf, { mergePages: false });
  return r.text.map(norm);
}

let total = 0;
let verified = 0;
let unverifiable = 0;
for (const f of readdirSync(dir)
  .filter((x) => /^extract-.*\.json$/.test(x))
  .sort()) {
  const fx = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const facts = fx.response.parsed_output?.facts ?? [];
  const text = await pages(fx.request.file);
  const layer = text.join("").length > 0;
  let ok = 0;
  for (const fact of facts) {
    total++;
    const q = mutate && fact.quote ? `${norm(fact.quote).slice(0, -1)}#` : norm(fact.quote);
    const onPage = q && (text[fact.page - 1] ?? "").includes(q);
    const anywhere = q && text.findIndex((p) => p.includes(q));
    if (!layer) {
      unverifiable++;
      console.log(`UNVERIFIABLE (no text layer) ${f} ${fact.field} p${fact.page} "${q}"`);
    } else if (onPage) {
      ok++;
      verified++;
    } else {
      const where =
        anywhere >= 0 ? `found on page ${anywhere + 1}, not ${fact.page}` : "not in text layer";
      console.log(`MISMATCH ${f} ${fact.field} p${fact.page} (${where}) "${q}"`);
    }
  }
  console.log(`${f}: ${ok}/${facts.length} verified${layer ? "" : " (image-only: no text layer)"}`);
}
const checkable = total - unverifiable;
console.log(
  `TOTAL verified ${verified}/${checkable} checkable facts (${checkable ? ((100 * verified) / checkable).toFixed(1) : "0"}%); ${unverifiable} unverifiable (image-only)`,
);
if (!total) process.exit(1);
