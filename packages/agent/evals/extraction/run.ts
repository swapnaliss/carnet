// Extraction eval (M2-02). Runs the real pipeline (`extractDocument` through the harness) over the
// synthetic dataset in fixtures/dataset/ and scores it against ground-truth.json.
//
//   --replay (default)  answers the model calls from fixtures/anthropic/extraction/<id>.json
//   --live              calls the model through the harness (real tokens), records each response there
//
// Metrics: per-field value accuracy, quote-verified rate, wrong-but-verified count (a verified fact
// whose value disagrees with ground truth), the mutation test (a quote altered by one word, moved to
// another page, or invented must come out unverified), and the flags raised on the injection document.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ExtractedFact, normalizeText } from "@carnet/domain";
import { EXTRACT_MODEL, type ExtractableDocument } from "../../src/extraction/extract";
import { readTextLayer } from "../../src/extraction/verify-quotes";
import {
  createHarness,
  EXTRACTION_PROMPTS,
  type ExtractionResult,
  extractDocument,
  type Transport,
  verifyFacts,
} from "../../src/index";
import { memoryStore, USD } from "../../test/memory-store";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DATASET = `${ROOT}fixtures/dataset/`;
export const RECORDINGS = `${ROOT}fixtures/anthropic/extraction/`;

export const THRESHOLDS = { valueAccuracy: 0.95, quoteVerifiedRate: 0.98 } as const;
/** Live spend guard inside the harness: the whole eval may not spend more than this. */
const LIVE_DAILY_CAP_NANO = Math.round(1.5 * USD);
const LIVE_PER_RUN_CAP_NANO = Math.round(0.25 * USD);

type GtValue = string | { amountMinor: number; currency: string };
interface GtFact {
  field: string;
  value: GtValue;
  quote: string | null;
  page: number;
}
interface GtDocument {
  id: string;
  file: string;
  kind: string;
  textLayer: boolean;
  sha256: string;
  facts: GtFact[];
}
interface GroundTruth {
  documents: GtDocument[];
}

const KIND_TO_DOC_KIND: Record<string, string> = {
  invoice: "invoice",
  contract: "contract",
  purchase_order: "purchase_order",
  bank_statement: "statement",
};

/** An eval case: a dataset file with the ground truth it is scored against. */
export interface EvalCase {
  readonly id: string;
  readonly file: string;
  readonly path: string;
  readonly docKind: string;
  readonly mime: ExtractableDocument["mime"];
  readonly textLayer: boolean;
  readonly gtId: string;
  readonly facts: readonly GtFact[];
}

export function loadCases(): EvalCase[] {
  const gt = JSON.parse(readFileSync(`${DATASET}ground-truth.json`, "utf8")) as GroundTruth;
  const cases: EvalCase[] = [];
  for (const d of gt.documents) {
    const docKind = KIND_TO_DOC_KIND[d.kind];
    if (!docKind) continue; // delivery notes and remittance advices have no extraction schema
    const bytes = readFileSync(`${DATASET}${d.file}`);
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== d.sha256) throw new Error(`${d.file} does not match ground-truth.json (sha256)`);
    cases.push({
      id: d.id,
      file: d.file,
      path: `${DATASET}${d.file}`,
      docKind,
      mime: "application/pdf",
      textLayer: d.textLayer,
      gtId: d.id,
      facts: d.facts,
    });
    if (d.id === "inv-nordlicht-scan-001") {
      for (const [ext, mime] of [
        ["png", "image/png"],
        ["jpg", "image/jpeg"],
      ] as const) {
        cases.push({
          id: `${d.id}-${ext}`,
          file: `scans/${d.id}.${ext}`,
          path: `${DATASET}scans/${d.id}.${ext}`,
          docKind,
          mime,
          textLayer: false,
          gtId: d.id,
          facts: d.facts,
        });
      }
    }
  }
  return cases;
}

// ---------------------------------------------------------------------------------------------
// Recordings

interface RecordedModelCall {
  response: {
    id: string;
    model: string;
    stop_reason: string;
    usage: Record<string, unknown>;
    content: unknown[];
  };
  request_id: string | null;
  latency_ms: number;
}
export interface Recording {
  kind: "extraction";
  document_id: string;
  file: string;
  sha256: string;
  doc_type: string;
  prompt_version: string;
  model: string;
  recorded_at: string;
  calls: RecordedModelCall[];
}

const recordingPath = (id: string) => `${RECORDINGS}${id}.json`;

export function loadRecording(id: string): Recording {
  try {
    return JSON.parse(readFileSync(recordingPath(id), "utf8")) as Recording;
  } catch {
    throw new Error(`no recording for ${id}: run the eval with --live once to record it`);
  }
}

export function replayTransport(recording: Recording): Transport {
  let i = 0;
  return async () => {
    const call = recording.calls[Math.min(i, recording.calls.length - 1)];
    i += 1;
    if (!call) throw new Error(`recording for ${recording.document_id} has no calls`);
    return new Response(
      JSON.stringify({
        id: call.response.id,
        type: "message",
        role: "assistant",
        model: call.response.model,
        content: call.response.content,
        stop_reason: call.response.stop_reason,
        stop_sequence: null,
        usage: call.response.usage,
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          ...(call.request_id ? { "request-id": call.request_id } : {}),
        },
      },
    );
  };
}

function recordingTransport(calls: RecordedModelCall[]): Transport {
  return async (input, init) => {
    const t0 = performance.now();
    const response = await fetch(input, init);
    const body = await response.text();
    if (response.ok) {
      const parsed = JSON.parse(body) as RecordedModelCall["response"];
      calls.push({
        response: {
          id: parsed.id,
          model: parsed.model,
          stop_reason: parsed.stop_reason,
          usage: parsed.usage,
          content: parsed.content,
        },
        request_id: response.headers.get("request-id"),
        latency_ms: Math.round(performance.now() - t0),
      });
    }
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

// ---------------------------------------------------------------------------------------------
// Scoring

const stripTrailing = (s: string) => normalizeText(s).replace(/[.,;]+$/, "");

export function matchesGroundTruth(gt: GtValue, fact: ExtractedFact): boolean {
  const p = fact.parsed;
  if (!p) return false;
  if (typeof gt === "object") {
    return p.type === "amount" && p.minor === String(gt.amountMinor) && p.currency === gt.currency;
  }
  const expected = stripTrailing(gt);
  if (p.type === "date") return p.date === expected;
  if (p.type === "text") return stripTrailing(p.text) === expected;
  return false;
}

interface FieldScore {
  total: number;
  correct: number;
}

export interface CaseReport {
  id: string;
  kind: string;
  text_layer: boolean;
  status: string;
  failure: string | null;
  facts: number;
  verified: number;
  cost_nano_usd: number;
  input_tokens: number;
  output_tokens: number;
  flags: number;
}

export interface EvalReport {
  mode: "replay" | "live";
  model: string;
  documents: number;
  text_documents: number;
  facts_scored: number;
  facts_correct: number;
  value_accuracy: number;
  per_field: Record<string, { total: number; correct: number; accuracy: number }>;
  facts_extracted_text_pdfs: number;
  facts_verified_text_pdfs: number;
  quote_verified_rate: number;
  wrong_but_verified: number;
  wrong_but_verified_detail: string[];
  extra_verified_unscored: number;
  mutation: {
    total: number;
    detected: number;
    by_kind: Record<string, { total: number; detected: number }>;
  };
  mutation_detected: number;
  injection_document: {
    id: string;
    flags: { kind: string; rule: string; match: string }[];
    all_ground_truth_facts_match: boolean;
    unexpected_keys: string[];
  };
  image_only: {
    documents: string[];
    facts: number;
    all_needs_confirmation: boolean;
    any_verified: boolean;
  };
  cost: {
    total_nano_usd: number;
    total_usd: number;
    input_tokens: number;
    output_tokens: number;
    calls: number;
  };
  wall_ms: number;
  thresholds: { value_accuracy: number; quote_verified_rate: number };
  passed: boolean;
  failures: string[];
  cases: CaseReport[];
}

const WORDS = /[A-Za-z]{3,}/;

/** The three mutations of a quote (ADR 0010): one altered word, a different page, an invented quote. */
export function mutate(
  fact: ExtractedFact,
  pageCount: number,
  pages: readonly string[],
): { kind: "altered_word" | "other_page" | "invented"; fact: { quote: string; page: number } }[] {
  const altered = fact.quote.replace(WORDS, "Xylophone");
  const otherPage = (() => {
    for (let p = 1; p <= pageCount + 1; p++) {
      if (p === fact.page) continue;
      const text = pages[p - 1] ?? "";
      if (!normalizeText(text).includes(normalizeText(fact.quote))) return p;
    }
    return pageCount + 1;
  })();
  return [
    { kind: "altered_word", fact: { quote: altered, page: fact.page } },
    { kind: "other_page", fact: { quote: fact.quote, page: otherPage } },
    {
      kind: "invented",
      fact: { quote: "Settlement reference: ZX-0000-INVENTED", page: fact.page },
    },
  ];
}

export interface RunOptions {
  mode: "replay" | "live";
  only?: string;
}

export async function runEval(options: RunOptions): Promise<EvalReport> {
  const t0 = Date.now();
  if (options.mode === "replay") process.env.ANTHROPIC_API_KEY ||= "replay-only-not-a-key";
  const cases = loadCases().filter((c) => !options.only || c.id === options.only);
  const results = new Map<string, ExtractionResult>();
  const reports: CaseReport[] = [];
  let calls = 0;

  for (const c of cases) {
    const bytes = new Uint8Array(readFileSync(c.path));
    const prompt = EXTRACTION_PROMPTS[c.docKind as keyof typeof EXTRACTION_PROMPTS];
    const store = memoryStore({
      agentsEnabled: true,
      perRunCapNanoUsd: LIVE_PER_RUN_CAP_NANO,
      dailyCapNanoUsd: LIVE_DAILY_CAP_NANO,
    });
    let recorded: RecordedModelCall[] = [];
    let transport: Transport;
    if (options.mode === "replay") {
      const rec = loadRecording(c.id);
      if (rec.prompt_version !== prompt.VERSION) {
        throw new Error(
          `recording ${c.id} is for prompt ${rec.prompt_version}, current is ${prompt.VERSION}: re-record with --live`,
        );
      }
      if (rec.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
        throw new Error(`recording ${c.id} is for different document bytes`);
      }
      transport = replayTransport(rec);
    } else {
      recorded = [];
      transport = recordingTransport(recorded);
    }
    const harness = createHarness({ store, transport });
    const run = await harness.startRun({ kind: "extraction-eval", ref: c.id });
    const result = await extractDocument({
      harness,
      run,
      step: `extract:eval`,
      document: { kind: c.docKind, mime: c.mime, bytes },
    });
    await harness.finishRun(run, result.status === "EXTRACTED" ? "DONE" : "FAILED");
    results.set(c.id, result);
    calls += store.steps.length;
    if (options.mode === "live") {
      const rec: Recording = {
        kind: "extraction",
        document_id: c.id,
        file: c.file,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        doc_type: c.docKind,
        prompt_version: prompt.VERSION,
        model: EXTRACT_MODEL,
        recorded_at: new Date().toISOString(),
        calls: recorded,
      };
      mkdirSync(RECORDINGS, { recursive: true });
      writeFileSync(recordingPath(c.id), `${JSON.stringify(rec, null, 2)}\n`);
    }
    reports.push({
      id: c.id,
      kind: c.docKind,
      text_layer: result.textLayer,
      status: result.status,
      failure: result.status === "EXTRACTION_FAILED" ? result.failure : null,
      facts: result.status === "EXTRACTED" ? result.facts.length : 0,
      verified:
        result.status === "EXTRACTED" ? result.facts.filter((f) => f.quote_verified).length : 0,
      cost_nano_usd: result.usage.costNanoUsd,
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      flags: result.injectionFlags.length,
    });
  }

  // --- value accuracy and wrong-but-verified, on text PDFs ---------------------------------
  const perField = new Map<string, FieldScore>();
  let scored = 0;
  let correct = 0;
  let extracted = 0;
  let verifiedCount = 0;
  let wrongButVerified = 0;
  const wrongDetail: string[] = [];
  let extraVerified = 0;
  const textCases = cases.filter((c) => c.textLayer);
  for (const c of textCases) {
    const r = results.get(c.id);
    if (!r || r.status !== "EXTRACTED") {
      for (const g of c.facts) {
        scored += 1;
        const s = perField.get(g.field) ?? { total: 0, correct: 0 };
        s.total += 1;
        perField.set(g.field, s);
      }
      continue;
    }
    extracted += r.facts.length;
    verifiedCount += r.facts.filter((f) => f.quote_verified).length;
    const gtKeys = new Set(c.facts.map((g) => g.field));
    extraVerified += r.facts.filter((f) => f.quote_verified && !gtKeys.has(f.key)).length;
    for (const g of c.facts) {
      const same = r.facts.filter((f) => f.key === g.field);
      const ok = same.some((f) => matchesGroundTruth(g.value, f));
      const verified = same.filter((f) => f.quote_verified);
      if (verified.length > 0 && !verified.some((f) => matchesGroundTruth(g.value, f))) {
        wrongButVerified += 1;
        wrongDetail.push(`${c.id}.${g.field}`);
      }
      scored += 1;
      if (ok) correct += 1;
      const s = perField.get(g.field) ?? { total: 0, correct: 0 };
      s.total += 1;
      if (ok) s.correct += 1;
      perField.set(g.field, s);
    }
  }

  // --- mutation test -----------------------------------------------------------------------
  const byKind: Record<string, { total: number; detected: number }> = {};
  let mutTotal = 0;
  let mutDetected = 0;
  for (const c of textCases) {
    const r = results.get(c.id);
    if (!r || r.status !== "EXTRACTED" || !r.docType) continue;
    const bytes = new Uint8Array(readFileSync(c.path));
    const layer = await readTextLayer(bytes);
    if (!layer) continue;
    for (const fact of r.facts.filter((f) => f.quote_verified)) {
      for (const m of mutate(fact, layer.pages.length, layer.pages)) {
        const [out] = verifyFacts(
          r.docType,
          [{ key: fact.key, value: fact.value, ...m.fact }],
          layer,
        );
        const slot = byKind[m.kind] ?? { total: 0, detected: 0 };
        slot.total += 1;
        mutTotal += 1;
        if (out && !out.quote_verified) {
          slot.detected += 1;
          mutDetected += 1;
        }
        byKind[m.kind] = slot;
      }
    }
  }

  // --- injection document ------------------------------------------------------------------
  const inj = results.get("inv-lakeside-002");
  const injCase = cases.find((c) => c.id === "inv-lakeside-002");
  const injFacts = inj?.status === "EXTRACTED" ? inj.facts : [];
  const gtKeys = new Set((injCase?.facts ?? []).map((g) => g.field));
  const injectionDocument = {
    id: "inv-lakeside-002",
    flags: (inj?.injectionFlags ?? []).map((f) => ({ kind: f.kind, rule: f.rule, match: f.match })),
    all_ground_truth_facts_match: (injCase?.facts ?? []).every((g) =>
      injFacts.some((f) => f.key === g.field && f.quote_verified && matchesGroundTruth(g.value, f)),
    ),
    unexpected_keys: injFacts.filter((f) => !gtKeys.has(f.key)).map((f) => f.key),
  };

  // --- image-only --------------------------------------------------------------------------
  const imageCases = cases.filter((c) => !c.textLayer);
  const imageFacts = imageCases.flatMap((c) => {
    const r = results.get(c.id);
    return r?.status === "EXTRACTED" ? r.facts : [];
  });

  const totalNano = reports.reduce((a, r) => a + r.cost_nano_usd, 0);
  const valueAccuracy = scored === 0 ? 0 : correct / scored;
  const quoteRate = extracted === 0 ? 0 : verifiedCount / extracted;
  const mutationRate = mutTotal === 0 ? 0 : mutDetected / mutTotal;
  const failures: string[] = [];
  if (wrongButVerified !== 0) failures.push(`wrong_but_verified is ${wrongButVerified}, must be 0`);
  if (valueAccuracy < THRESHOLDS.valueAccuracy)
    failures.push(`value_accuracy ${valueAccuracy.toFixed(4)} < ${THRESHOLDS.valueAccuracy}`);
  if (quoteRate < THRESHOLDS.quoteVerifiedRate)
    failures.push(`quote_verified_rate ${quoteRate.toFixed(4)} < ${THRESHOLDS.quoteVerifiedRate}`);
  if (mutationRate !== 1) failures.push(`mutation_detected ${mutationRate}, must be 1`);
  if (injectionDocument.flags.length === 0) failures.push("no injection flags on inv-lakeside-002");
  if (!injectionDocument.all_ground_truth_facts_match)
    failures.push("injection document facts differ from ground truth");
  if (imageFacts.some((f) => !f.needs_confirmation || f.quote_verified))
    failures.push("an image-only fact is not needs_confirmation");

  const fieldObj: EvalReport["per_field"] = {};
  for (const [k, v] of [...perField.entries()].sort()) {
    fieldObj[k] = { ...v, accuracy: v.total === 0 ? 0 : Number((v.correct / v.total).toFixed(4)) };
  }
  return {
    mode: options.mode,
    model: EXTRACT_MODEL,
    documents: cases.length,
    text_documents: textCases.length,
    facts_scored: scored,
    facts_correct: correct,
    value_accuracy: Number(valueAccuracy.toFixed(4)),
    per_field: fieldObj,
    facts_extracted_text_pdfs: extracted,
    facts_verified_text_pdfs: verifiedCount,
    quote_verified_rate: Number(quoteRate.toFixed(4)),
    wrong_but_verified: wrongButVerified,
    wrong_but_verified_detail: wrongDetail,
    extra_verified_unscored: extraVerified,
    mutation: { total: mutTotal, detected: mutDetected, by_kind: byKind },
    mutation_detected: mutationRate,
    injection_document: injectionDocument,
    image_only: {
      documents: imageCases.map((c) => c.id),
      facts: imageFacts.length,
      all_needs_confirmation: imageFacts.every((f) => f.needs_confirmation),
      any_verified: imageFacts.some((f) => f.quote_verified),
    },
    cost: {
      total_nano_usd: totalNano,
      total_usd: Number((totalNano / USD).toFixed(6)),
      input_tokens: reports.reduce((a, r) => a + r.input_tokens, 0),
      output_tokens: reports.reduce((a, r) => a + r.output_tokens, 0),
      calls,
    },
    wall_ms: Date.now() - t0,
    thresholds: {
      value_accuracy: THRESHOLDS.valueAccuracy,
      quote_verified_rate: THRESHOLDS.quoteVerifiedRate,
    },
    passed: failures.length === 0,
    failures,
    cases: reports,
  };
}
