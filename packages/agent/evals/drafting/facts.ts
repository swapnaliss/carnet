// The facts the drafting eval sees: every dataset document run through the real extraction pipeline
// with the recorded model replies of M2-02 (fixtures/anthropic/extraction/), so no new model call is
// made and the facts are exactly what the product would store.
import { readFileSync } from "node:fs";
import { createHarness, type ExtractionResult, extractDocument } from "../../src/index";
import { memoryStore } from "../../test/memory-store";
import { loadCases, loadRecording, replayTransport } from "../extraction/run";

let cache: Promise<Map<string, ExtractionResult>> | null = null;

export function runExtractionForEval(): Promise<Map<string, ExtractionResult>> {
  cache ??= (async () => {
    process.env.ANTHROPIC_API_KEY ||= "replay-only-not-a-key";
    const out = new Map<string, ExtractionResult>();
    for (const c of loadCases()) {
      if (c.mime !== "application/pdf") continue; // the PDF scan stands for the scanned invoice
      const harness = createHarness({
        store: memoryStore({ agentsEnabled: true }),
        transport: replayTransport(loadRecording(c.id)),
      });
      const run = await harness.startRun({ kind: "extraction-eval", ref: c.id });
      const result = await extractDocument({
        harness,
        run,
        step: "extract:eval",
        document: { kind: c.docKind, mime: c.mime, bytes: new Uint8Array(readFileSync(c.path)) },
      });
      out.set(c.gtId, result);
    }
    return out;
  })();
  return cache;
}
