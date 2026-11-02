#!/usr/bin/env node
// Verifies fixtures/dataset (M0-08): checksums, regeneration is byte-identical, every ground-truth quote
// is verbatim on its page of the PDF text layer (unpdf), the five adversarial cases and RFI topics are
// present, no real-looking identifiers, size under 5 MB.
//
//   node scripts/dataset/check.mjs fixtures/dataset
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractText, getDocumentProxy } from "unpdf";
import { generate } from "./generate.mjs";

const dir = resolve(
  process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/dataset"),
);
const errors = [];
const fail = (m) => errors.push(m);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const list = (d) =>
  readdirSync(d)
    .sort()
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? list(p) : [p];
    });
const files = list(dir);

// 1. checksums.txt matches the files
const sums = new Map(
  readFileSync(join(dir, "checksums.txt"), "utf8")
    .trim()
    .split("\n")
    .map((l) => {
      const [h, ...p] = l.split("  ");
      return [p.join("  "), h];
    }),
);
for (const f of files) {
  const rel = relative(dir, f);
  if (rel === "checksums.txt") continue;
  if (sums.get(rel) !== sha(readFileSync(f))) fail(`checksum mismatch: ${rel}`);
  sums.delete(rel);
}
for (const rel of sums.keys()) fail(`checksums.txt lists a missing file: ${rel}`);

// 2. regeneration is byte-identical
const tmp = mkdtempSync(join(tmpdir(), "m0-08-check-"));
try {
  await generate(tmp);
  const a = list(tmp).map((f) => `${relative(tmp, f)} ${sha(readFileSync(f))}`);
  const b = files.map((f) => `${relative(dir, f)} ${sha(readFileSync(f))}`);
  if (a.join("\n") !== b.join("\n"))
    fail("regenerating produces different bytes than the committed dataset");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// 3. every quote is verbatim on its page of the text layer
const gt = JSON.parse(readFileSync(join(dir, "ground-truth.json"), "utf8"));
const pageText = {};
for (const d of gt.documents) {
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(join(dir, d.file))));
  const r = await extractText(pdf, { mergePages: false });
  pageText[d.id] = r.text;
  if (r.totalPages !== d.pages)
    fail(`${d.id}: ground truth says ${d.pages} pages, PDF has ${r.totalPages}`);
  if (d.textLayer === false) {
    if (r.text.join("").trim() !== "") fail(`${d.id}: declared image-only but has a text layer`);
    for (const f of d.facts)
      if (f.quote !== null) fail(`${d.id}.${f.field}: image-only fact must have quote null`);
    if (!d.facts.length) fail(`${d.id}: image-only entry lists no facts`);
    continue;
  }
  for (const f of d.facts) {
    if (!r.text[f.page - 1]?.includes(f.quote))
      fail(`${d.id}.${f.field}: quote not verbatim on page ${f.page}: ${f.quote}`);
  }
}
const inj = gt.cases.find((c) => c.case === "injection");
if (inj && !pageText[inj.documentId]?.[inj.page - 1]?.includes(inj.quote))
  fail("injection quote not found on its page");

// 4. adversarial cases and RFI sets
for (const c of ["followup", "injection", "contradict", "missing-contract", "image-only"]) {
  const e = gt.cases.find((x) => x.case === c);
  if (!e) fail(`ground truth lacks case ${c}`);
  else if (!e.expectedHandling) fail(`case ${c} lacks expectedHandling`);
}
const topics = ["purpose", "relationship", "source_of_funds", "proof_of_delivery"];
let followupRepeats = false;
for (const f of files.filter((x) => x.includes("rfi-sets"))) {
  const s = JSON.parse(readFileSync(f, "utf8"));
  const r1 = s.rounds[0].questions;
  for (const t of topics)
    if (!r1.some((q) => q.topic === t)) fail(`${relative(dir, f)} lacks topic ${t}`);
  for (const q of r1) {
    if (!q.id || !q.title?.en || !q.answer?.type || !q.expected?.status)
      fail(`${relative(dir, f)}: malformed question ${q.id}`);
  }
  for (const r of s.rounds.slice(1)) {
    if (r.questions.some((q) => r1.some((p) => p.id === q.id) && q.reopened))
      followupRepeats = true;
  }
}
if (!followupRepeats) fail("no RFI set has a follow-up round that repeats a question");

// 5. no real-looking identifiers
const mod97 = (iban) => {
  const s = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => c.charCodeAt(0) - 55);
  let rem = 0;
  for (const ch of s) rem = (rem * 10 + Number(ch)) % 97;
  return rem;
};
const abaOk = (r) =>
  (3 * (+r[0] + +r[3] + +r[6]) + 7 * (+r[1] + +r[4] + +r[7]) + (+r[2] + +r[5] + +r[8])) % 10 === 0;
const corpus = [
  ...files
    .filter((f) => f.endsWith(".json"))
    .map((f) => [relative(dir, f), readFileSync(f, "utf8")]),
  ...Object.entries(pageText).map(([id, t]) => [`${id}.pdf`, t.join("\n")]),
];
for (const [name, text] of corpus) {
  for (const m of text.matchAll(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g)) {
    if (/^(DE|NL|GB|FR)/.test(m[0]) && mod97(m[0]) === 1)
      fail(`${name}: IBAN passes the mod-97 checksum: ${m[0].slice(0, 4)}...`);
  }
  for (const m of text.matchAll(/(?:Routing number|routingNumber)\D{0,6}(\d{9})/g)) {
    if (abaOk(m[1])) fail(`${name}: routing number passes the ABA checksum`);
  }
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
    if (!/(^|\.)example\.(com|org|net)$/.test(m[1]))
      fail(`${name}: non-example email domain ${m[1]}`);
  }
}

// 6. size
const bytes = files.reduce((a, f) => a + statSync(f).size, 0);
if (bytes >= 5 * 1024 * 1024) fail(`dataset is ${bytes} bytes (limit 5 MB)`);

if (errors.length) {
  console.error(
    `dataset check: ${errors.length} problem(s)\n${errors.map((e) => `  - ${e}`).join("\n")}`,
  );
  process.exit(1);
}
console.log(
  `dataset check: ok (${files.length} files, ${gt.documents.length} documents, ${bytes} bytes)`,
);
