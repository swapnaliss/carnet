// Shared helpers for the extraction tests: dataset bytes, recorded model replies, a harness over the
// in-memory store, and the eval's case list.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type EvalCase,
  loadCases,
  loadRecording,
  replayTransport,
} from "../../evals/extraction/run";
import { createHarness, type ExtractableDocument, type Transport } from "../../src/index";
import { type MemoryStore, memoryStore } from "../memory-store";

export const DATASET = fileURLToPath(new URL("../../../../fixtures/dataset/", import.meta.url));

export const cases = (): EvalCase[] => loadCases();
export const caseById = (id: string): EvalCase => {
  const c = cases().find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};
export const documentOf = (c: EvalCase): ExtractableDocument => ({
  kind: c.docKind,
  mime: c.mime,
  bytes: new Uint8Array(readFileSync(c.path)),
});

export interface Rig {
  store: MemoryStore;
  requests: { rawBody: string; body: Record<string, unknown> }[];
  harness: ReturnType<typeof createHarness>;
}

/** A harness whose model is the recording of `id` (or `responder`), counting every request. */
export function rig(
  transport: Transport,
  flags: Parameters<typeof memoryStore>[0] = {},
  store: MemoryStore = memoryStore(flags),
): Rig {
  process.env.ANTHROPIC_API_KEY ||= "test-not-a-key";
  const requests: Rig["requests"] = [];
  const counting: Transport = async (input, init) => {
    const rawBody = typeof init?.body === "string" ? init.body : "";
    requests.push({
      rawBody,
      body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
    });
    return transport(input, init);
  };
  return { store, requests, harness: createHarness({ store, transport: counting, maxRetries: 0 }) };
}

export const replayOf = (id: string): Transport => replayTransport(loadRecording(id));
